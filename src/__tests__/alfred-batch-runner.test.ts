import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ANTHROPIC_EPHEMERAL_CACHE_MIN_CHARS,
  BatchEuOnlyError,
  BatchPathBoundaryError,
  BatchPayloadTooLargeError,
  BatchSecretGateError,
  batchWorksourceQueueRoot,
  buildAnthropicBatchRequestItem,
  buildBatchQaSamplePrompt,
  cancelBatchJob,
  clearBatchRunnerCaches,
  computeBatchCostBreakdown,
  DuplicateCustomIdError,
  ensureBatchJobsTable,
  getAdminBatchesOverview,
  getBatchJobById,
  pollBatchJob,
  pollPendingBatches,
  recoverStuckBatchJobs,
  resolveBatchProvider,
  submitBatchJob,
  validateAndScanCanonicalJsonl,
  type CanonicalBatchInputItem,
} from '../alfred/batch-runner.js'
import {
  BudgetExceededError,
  DEFAULT_TOKEN_PRICES_USD,
  globalTokenSpend,
  recordModelTokenUsage,
} from '../alfred/circuit-breaker.js'
import { inspectBatchJobsTable } from '../alfred/housekeeper.js'
import { evaluateCliQuotaForBatch, runHybridAgentTurn } from '../alfred/model-router.js'
import { executeWhitelistedToolAsync } from '../alfred/tool-executor.js'
import type { AlfredAgentDefinition } from '../alfred/agents-config.js'
import { agentSpend } from '../costops/agent-budgets.js'
import { holdStorePath, readHoldStore, writeHoldStore } from '../web/heavy-job-hold.js'
import { worksourceItemStageAt } from '../web/worksource-queue.js'

function createInMemoryDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent TEXT NOT NULL,
      session_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      thinking_tokens INTEGER NOT NULL DEFAULT 0,
      model TEXT,
      content_preview TEXT,
      tool_name TEXT,
      task_title TEXT,
      project TEXT
    );
    CREATE UNIQUE INDEX idx_token_usage_dedup ON token_usage(agent, session_id, timestamp, input_tokens, output_tokens);
  `)
  ensureBatchJobsTable(db)
  return db
}

function writeCanonicalJsonl(dir: string, relName: string, items: Array<Record<string, unknown>>): string {
  const full = join(dir, relName)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, items.map((it) => JSON.stringify(it)).join('\n') + '\n', 'utf-8')
  return relName
}

describe('Alfred Multi-Provider Async Batch Runner', () => {
  let tmpRoot: string
  let db: Database.Database

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'alfred-batch-test-'))
    mkdirSync(join(tmpRoot, 'batch'), { recursive: true })
    mkdirSync(join(tmpRoot, 'store', 'batch'), { recursive: true })
    db = createInMemoryDb()
    clearBatchRunnerCaches()
  })

  afterEach(() => {
    try { db.close() } catch { /* ignore */ }
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('rejects duplicate custom_id and invalid custom_id regex without creating per-line queue files', async () => {
    const dupFile = writeCanonicalJsonl(tmpRoot, 'batch/dup.jsonl', [
      { custom_id: 'item_1', prompt: 'Hello 1' },
      { custom_id: 'item_1', prompt: 'Hello 2' },
    ])
    await expect(
      validateAndScanCanonicalJsonl(join(tmpRoot, dupFile), dupFile),
    ).rejects.toThrow(DuplicateCustomIdError)

    const badIdFile = writeCanonicalJsonl(tmpRoot, 'batch/badid.jsonl', [
      { custom_id: 'bad id with spaces!', prompt: 'Hello' },
    ])
    await expect(
      validateAndScanCanonicalJsonl(join(tmpRoot, badIdFile), badIdFile),
    ).rejects.toThrow(/Invalid custom_id/i)
  })

  it('blocks secret-bearing JSONL inputs via secret-gate without leaking raw secret in error', async () => {
    const fakeSecret = 'sk' + '_live_' + '1234567890abcdef1234567890'
    const secretFile = writeCanonicalJsonl(tmpRoot, 'batch/leak.jsonl', [
      { custom_id: 'sec_1', prompt: `Please use key ${fakeSecret}` },
    ])
    let caught: unknown
    try {
      await validateAndScanCanonicalJsonl(join(tmpRoot, secretFile), secretFile)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(BatchSecretGateError)
    expect((caught as Error).message).not.toContain(fakeSecret)
  })

  it('enforces strict batch/ and store/batch/ path confinement for batch_submit and alfred-batch fs_write', async () => {
    writeFileSync(join(tmpRoot, 'outside.jsonl'), JSON.stringify({ custom_id: 'x1', prompt: 'hi' }) + '\n')
    await expect(
      submitBatchJob({
        db,
        inputPath: 'outside.jsonl',
        projectRoot: tmpRoot,
        env: { OPENAI_API_KEY: 'test-key' },
      }),
    ).rejects.toThrow(BatchPathBoundaryError)

    const batchAgent: AlfredAgentDefinition = {
      id: 'alfred-batch',
      displayName: 'Alfred Batch',
      channelName: '#alfred-batch',
      discordChannelId: '123456789012345678',
      provider: 'vertex-eu',
      model: 'gemini-2.5-flash',
      workspace: '.',
      workspaceAbsPath: tmpRoot,
      memoryNamespace: 'alfred-batch',
      dailyBudgetUsd: 3.0,
      allowedUserIds: [],
      tools: ['fs_write', 'fs_read', 'batch_submit', 'batch_status', 'batch_list', 'batch_cancel'],
      resolvedSystemPrompt: '',
    }

    await expect(
      executeWhitelistedToolAsync({ agent: batchAgent, db }, 'fs_write', {
        path: 'src/evil.ts',
        content: 'bad',
      }),
    ).rejects.toThrow(BatchPathBoundaryError)

    const okRes = await executeWhitelistedToolAsync({ agent: batchAgent, db }, 'fs_write', {
      path: 'batch/allowed.jsonl',
      content: '{"custom_id":"ok_1","prompt":"hello"}\n',
    })
    expect(okRes).toContain('OK: Wrote')
  })

  it('routes auto provider by eu_only, task_type, and falls back across configured providers (never non-EU when eu_only)', () => {
    const fullEnv = {
      ANTHROPIC_API_KEY: 'ant-key',
      GEMINI_API_KEY: 'gem-key',
      OPENAI_API_KEY: 'oai-key',
      VERTEX_EU_BATCH_BUCKET: 'my-eu-bucket',
      VERTEX_EU_ACCESS_TOKEN: 'v-tok',
      VERTEX_EU_PROJECT_ID: 'my-proj',
      VERTEX_EU_BATCH_LOCATION: 'europe-central2',
    }

    // eu_only -> strictly vertex-eu
    const euPlan = resolveBatchProvider({ requestedProvider: 'auto', euOnly: true, env: fullEnv })
    expect(euPlan.primary).toBe('vertex-eu')
    expect(euPlan.candidates).toEqual(['vertex-eu'])

    // eu_only without VERTEX_EU_BATCH_BUCKET -> GDPR error, no fallback
    expect(() =>
      resolveBatchProvider({
        requestedProvider: 'auto',
        euOnly: true,
        env: { ...fullEnv, VERTEX_EU_BATCH_BUCKET: '' },
      }),
    ).toThrow(BatchEuOnlyError)

    // code/reasoning -> anthropic first
    const codePlan = resolveBatchProvider({ requestedProvider: 'auto', taskType: 'code', env: fullEnv })
    expect(codePlan.primary).toBe('anthropic')
    expect(codePlan.candidates).toEqual(['anthropic', 'gemini', 'vertex-eu', 'openai'])

    // translation/extraction/general -> gemini -> vertex-eu -> openai -> anthropic
    const trPlan = resolveBatchProvider({ requestedProvider: 'auto', taskType: 'translation', env: fullEnv })
    expect(trPlan.primary).toBe('gemini')
    expect(trPlan.candidates).toEqual(['gemini', 'vertex-eu', 'openai', 'anthropic'])

    // Missing gemini key falls back to vertex-eu
    const noGemPlan = resolveBatchProvider({
      requestedProvider: 'auto',
      taskType: 'general',
      env: { ...fullEnv, GEMINI_API_KEY: '' },
    })
    expect(noGemPlan.primary).toBe('vertex-eu')
  })

  it('applies Anthropic ephemeral cache_control ONLY on shared long system prefixes (>=1024 tokens) and enforces payload limits + POST cancel', async () => {
    const longSys = 'A'.repeat(ANTHROPIC_EPHEMERAL_CACHE_MIN_CHARS + 50)
    const shortSys = 'Short system'
    const sharedSet = new Set<string>([longSys])

    const reqLong = buildAnthropicBatchRequestItem(
      { custom_id: 'c1', system: longSys, prompt: 'P1' },
      'claude-sonnet-4-6',
      sharedSet,
    ) as { params: { system: Array<{ cache_control?: { type: string } }> } }
    expect(reqLong.params.system[0].cache_control).toEqual({ type: 'ephemeral' })

    const reqShort = buildAnthropicBatchRequestItem(
      { custom_id: 'c2', system: shortSys, prompt: 'P2' },
      'claude-sonnet-4-6',
      sharedSet,
    ) as { params: { system: Array<{ cache_control?: { type: string } }> } }
    expect(reqShort.params.system[0].cache_control).toBeUndefined()

    const relPath = writeCanonicalJsonl(tmpRoot, 'batch/ant.jsonl', [
      { custom_id: 'a1', system: longSys, prompt: 'Write code 1', task_type: 'code' },
      { custom_id: 'a2', system: longSys, prompt: 'Write code 2', task_type: 'code' },
    ])

    // Payload limit rejection (maxAnthropicRequests: 1)
    await expect(
      submitBatchJob({
        db,
        inputPath: relPath,
        provider: 'anthropic',
        projectRoot: tmpRoot,
        env: { ANTHROPIC_API_KEY: 'ant-key' },
        maxAnthropicRequests: 1,
      }),
    ).rejects.toThrow(/All configured Batch providers failed.*limit exceeded/)

    // Full Anthropic submit -> poll -> cancel flow
    const calls: Array<{ url: string; method: string }> = []
    const mockFetch: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push({ url, method })
      if (url.endsWith('/v1/messages/batches') && method === 'POST') {
        return new Response(JSON.stringify({ id: 'msgbatch_123' }), { status: 200 })
      }
      if (url.endsWith('/v1/messages/batches/msgbatch_123/cancel') && method === 'POST') {
        return new Response(JSON.stringify({ id: 'msgbatch_123', processing_status: 'canceling' }), { status: 200 })
      }
      if (url.endsWith('/v1/messages/batches/msgbatch_123') && method === 'GET') {
        return new Response(
          JSON.stringify({
            id: 'msgbatch_123',
            processing_status: 'ended',
            results_url: 'https://api.anthropic.com/v1/messages/batches/msgbatch_123/results',
          }),
          { status: 200 },
        )
      }
      if (url.endsWith('/results')) {
        const lines = [
          JSON.stringify({
            custom_id: 'a1',
            result: {
              type: 'succeeded',
              message: {
                content: [{ type: 'text', text: 'Result 1' }],
                usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 2000, cache_read_input_tokens: 0 },
              },
            },
          }),
          JSON.stringify({
            custom_id: 'a2',
            result: {
              type: 'succeeded',
              message: {
                content: [{ type: 'text', text: 'Result 2' }],
                usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 2000 },
              },
            },
          }),
        ].join('\n')
        return new Response(lines, { status: 200 })
      }
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch

    const job = await submitBatchJob({
      db,
      inputPath: relPath,
      provider: 'auto',
      projectRoot: tmpRoot,
      env: { ANTHROPIC_API_KEY: 'ant-key' },
      fetchImpl: mockFetch,
      nowSec: 1_700_000_000,
    })
    expect(job.provider).toBe('anthropic')
    expect(job.status).toBe('submitted')
    expect(worksourceItemStageAt(batchWorksourceQueueRoot(tmpRoot), job.id)).toBe('active')

    // Test cancel uses POST /cancel (never DELETE)
    const cancelledJob = await cancelBatchJob({
      db,
      batchId: job.id,
      projectRoot: tmpRoot,
      env: { ANTHROPIC_API_KEY: 'ant-key' },
      fetchImpl: mockFetch,
    })
    expect(cancelledJob.status).toBe('cancelled')
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/msgbatch_123/cancel'))).toBe(true)
    expect(worksourceItemStageAt(batchWorksourceQueueRoot(tmpRoot), job.id)).toBe('done')

    // Submit a second job and complete it with QA sampling + Discord notification + atomic cost_recorded
    const job2 = await submitBatchJob({
      db,
      inputPath: relPath,
      provider: 'anthropic',
      projectRoot: tmpRoot,
      env: { ANTHROPIC_API_KEY: 'ant-key', DISCORD_CHANNEL_ALFRED_BATCH: '999888777666555444' },
      fetchImpl: mockFetch,
      nowSec: 1_700_000_010,
    })

    const sentDiscord: Array<{ ch: string; msg: string }> = []
    const qaCalls: string[] = []
    const pollRes = await pollBatchJob({
      db,
      batchId: job2.id,
      projectRoot: tmpRoot,
      env: { ANTHROPIC_API_KEY: 'ant-key', DISCORD_CHANNEL_ALFRED_BATCH: '999888777666555444' },
      fetchImpl: mockFetch,
      nowSec: 1_700_000_020,
      agentsConfig: {
        version: 1,
        global: { defaultProvider: 'deepseek', defaultModel: 'deepseek-chat', dailyBudgetUsd: 15, budgetMultiplier: 1, runtimeMode: 'production', workspacesRoot: 'workspaces' },
        roles: {} as never,
        agents: [
          {
            id: 'alfred-qa',
            displayName: 'Alfred QA',
            channelName: '#alfred-qa',
            discordChannelId: '333',
            provider: 'vertex-eu',
            model: 'gemini-2.5-flash',
            workspace: 'workspaces/alfred-qa',
            workspaceAbsPath: tmpRoot,
            memoryNamespace: 'alfred-qa',
            dailyBudgetUsd: 2,
            allowedUserIds: [],
            tools: [],
            resolvedSystemPrompt: '',
          },
        ],
      },
      qaRunnerFn: async (_qaAgent, prompt) => {
        qaCalls.push(prompt)
        return 'OK: mindkét mintaelem rendben van.'
      },
      sendToDiscord: async (ch, msg) => {
        sentDiscord.push({ ch, msg })
      },
    })

    expect(pollRes.transitioned).toBe(true)
    expect(pollRes.job.status).toBe('completed')
    expect(pollRes.job.completed_items).toBe(2)
    expect(pollRes.job.cost_recorded).toBe(1)
    expect(pollRes.job.actual_cost_usd).toBeGreaterThan(0)
    expect(pollRes.job.saved_cost_usd).toBeCloseTo(pollRes.job.actual_cost_usd!, 8)
    expect(qaCalls.length).toBe(1)
    expect(qaCalls[0]).toContain('<untrusted')
    expect(qaCalls[0]).toContain('[KOTEG:')
    expect(sentDiscord.length).toBe(1)
    expect(sentDiscord[0].msg).toContain('Alfred QA mintavétel')

    // Verify 0.5x batch multiplier in token_usage aggregation (circuit-breaker + agent-budgets)
    const dayStart = Math.floor(Date.UTC(2023, 10, 14) / 1000)
    const dayEnd = dayStart + 86_400
    const globalStat = globalTokenSpend(db, dayStart, dayEnd, DEFAULT_TOKEN_PRICES_USD)
    const agentStat = agentSpend(db, 'alfred-batch', dayStart, dayEnd, DEFAULT_TOKEN_PRICES_USD)
    expect(globalStat.cost).toBeCloseTo(pollRes.job.actual_cost_usd!, 6)
    expect(agentStat.cost).toBeCloseTo(pollRes.job.actual_cost_usd!, 6)
  })

  it('handles Gemini upload + x-goog-api-key header on ?alt=media download, Vertex EU bucket EU verification + multi-shard GCS merge, and OpenAI multipart + error_file_id + expired', async () => {
    const relPath = writeCanonicalJsonl(tmpRoot, 'batch/multi.jsonl', [
      { custom_id: 'm1', system: 'Translate', prompt: 'Hello' },
      { custom_id: 'm2', system: 'Translate', prompt: 'World' },
    ])

    // 1. Gemini adapter test (asserts x-goog-api-key header, NO ?key= query param)
    let geminiDownloadUrl = ''
    let geminiDownloadHeaderKey = ''
    const geminiFetch: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input)
      const headers = (init?.headers ?? {}) as Record<string, string>
      if (url.includes('/upload/v1beta/files')) {
        return new Response(JSON.stringify({ file: { name: 'files/gem_in_1' } }), { status: 200 })
      }
      if (url.includes(':batchGenerateContent')) {
        return new Response(JSON.stringify({ name: 'batches/gem_job_1' }), { status: 200 })
      }
      if (url.includes('?alt=media')) {
        geminiDownloadUrl = url
        geminiDownloadHeaderKey = headers['x-goog-api-key'] ?? ''
        const body = [
          JSON.stringify({ key: 'm1', response: { candidates: [{ content: { parts: [{ text: 'Szia' }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 } } }),
          JSON.stringify({ key: 'm2', response: { candidates: [{ content: { parts: [{ text: 'Világ' }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 } } }),
        ].join('\n')
        return new Response(body, { status: 200 })
      }
      if (url.includes('/v1beta/batches/gem_job_1')) {
        return new Response(JSON.stringify({ done: true, response: { responsesFile: 'files/gem_out_1' } }), { status: 200 })
      }
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch

    const gemJob = await submitBatchJob({
      db,
      inputPath: relPath,
      provider: 'gemini',
      projectRoot: tmpRoot,
      env: { GEMINI_API_KEY: 'gem-secret-key' },
      fetchImpl: geminiFetch,
      nowSec: 1_700_001_000,
    })
    const gemPoll = await pollBatchJob({
      db,
      batchId: gemJob.id,
      projectRoot: tmpRoot,
      env: { GEMINI_API_KEY: 'gem-secret-key' },
      fetchImpl: geminiFetch,
      nowSec: 1_700_001_010,
    })
    expect(gemPoll.job.status).toBe('completed')
    expect(gemPoll.job.completed_items).toBe(2)
    expect(geminiDownloadUrl).toContain('?alt=media')
    expect(geminiDownloadUrl).not.toContain('key=')
    expect(geminiDownloadHeaderKey).toBe('gem-secret-key')

    // 2. Vertex EU adapter test (bucket location check + 2 shards merged)
    const vertexFetch: typeof fetch = vi.fn(async (input) => {
      const url = String(input)
      if (url.includes('storage/v1/b/eu-bucket?fields=location')) {
        return new Response(JSON.stringify({ location: 'EUROPE-CENTRAL2' }), { status: 200 })
      }
      if (url.includes('/upload/storage/v1/b/eu-bucket/o')) {
        return new Response(JSON.stringify({ name: 'input.jsonl' }), { status: 200 })
      }
      if (url.includes('/batchPredictionJobs') && !url.includes('bpj_1')) {
        return new Response(JSON.stringify({ name: 'projects/proj-eu-1/locations/europe-central2/batchPredictionJobs/bpj_1' }), { status: 200 })
      }
      if (url.includes('batchPredictionJobs/bpj_1')) {
        return new Response(JSON.stringify({ state: 'JOB_STATE_SUCCEEDED', outputInfo: { gcsOutputDirectory: 'gs://eu-bucket/out/' } }), { status: 200 })
      }
      if (url.includes('storage/v1/b/eu-bucket/o?prefix=')) {
        return new Response(JSON.stringify({ items: [{ name: 'out/predictions-00001.jsonl' }, { name: 'out/predictions-00002.jsonl' }] }), { status: 200 })
      }
      if (url.includes('predictions-00001.jsonl')) {
        return new Response(JSON.stringify({ custom_id: 'm1', response: { candidates: [{ content: { parts: [{ text: 'EU-1' }] } }], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 25 } } }) + '\n', { status: 200 })
      }
      if (url.includes('predictions-00002.jsonl')) {
        return new Response(JSON.stringify({ custom_id: 'm2', response: { candidates: [{ content: { parts: [{ text: 'EU-2' }] } }], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 25 } } }) + '\n', { status: 200 })
      }
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch

    const vEnv = {
      VERTEX_EU_BATCH_BUCKET: 'eu-bucket',
      VERTEX_EU_ACCESS_TOKEN: 'v-tok',
      VERTEX_EU_PROJECT_ID: 'proj-eu-1',
      VERTEX_EU_BATCH_LOCATION: 'europe-central2',
    }
    const vJob = await submitBatchJob({
      db,
      inputPath: relPath,
      provider: 'auto',
      euOnly: true,
      projectRoot: tmpRoot,
      env: vEnv,
      fetchImpl: vertexFetch,
      nowSec: 1_700_002_000,
    })
    const vPoll = await pollBatchJob({
      db,
      batchId: vJob.id,
      projectRoot: tmpRoot,
      env: vEnv,
      fetchImpl: vertexFetch,
      nowSec: 1_700_002_010,
    })
    expect(vPoll.job.provider).toBe('vertex-eu')
    expect(vPoll.job.status).toBe('completed')
    expect(vPoll.job.completed_items).toBe(2)

    // 3. OpenAI adapter test (multipart/form-data + output_file_id + error_file_id + expired)
    let openAiUploadContentType = ''
    const openAiFetch: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input)
      const headers = (init?.headers ?? {}) as Record<string, string>
      if (url.endsWith('/files') && init?.method === 'POST') {
        openAiUploadContentType = headers['Content-Type'] ?? ''
        return new Response(JSON.stringify({ id: 'file_in_1' }), { status: 200 })
      }
      if (url.endsWith('/batches') && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'batch_oai_1' }), { status: 200 })
      }
      if (url.endsWith('/batches/batch_oai_1')) {
        return new Response(
          JSON.stringify({
            id: 'batch_oai_1',
            status: 'expired',
            output_file_id: 'file_out_1',
            error_file_id: 'file_err_1',
          }),
          { status: 200 },
        )
      }
      if (url.endsWith('/files/file_out_1/content')) {
        return new Response(
          JSON.stringify({
            custom_id: 'm1',
            response: { status_code: 200, body: { choices: [{ message: { content: 'OAI-1' } }], usage: { prompt_tokens: 100, completion_tokens: 40 } } },
          }) + '\n',
          { status: 200 },
        )
      }
      if (url.endsWith('/files/file_err_1/content')) {
        return new Response(
          JSON.stringify({ custom_id: 'm2', error: { message: 'rate_limit_exceeded' } }) + '\n',
          { status: 200 },
        )
      }
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch

    const oJob = await submitBatchJob({
      db,
      inputPath: relPath,
      provider: 'openai',
      projectRoot: tmpRoot,
      env: { OPENAI_API_KEY: 'oai-key' },
      fetchImpl: openAiFetch,
      nowSec: 1_700_003_000,
    })
    expect(openAiUploadContentType).toContain('multipart/form-data; boundary=')
    const oPoll = await pollBatchJob({
      db,
      batchId: oJob.id,
      projectRoot: tmpRoot,
      env: { OPENAI_API_KEY: 'oai-key' },
      fetchImpl: openAiFetch,
      nowSec: 1_700_003_010,
    })
    expect(oPoll.job.status).toBe('completed')
    expect(oPoll.job.completed_items).toBe(1)
    expect(oPoll.job.failed_items).toBe(1)
    const outText = readFileSync(join(tmpRoot, oPoll.job.output_path!), 'utf-8')
    expect(outText).toContain('"status":"error"')
    expect(outText).toContain('rate_limit_exceeded')

    // Admin overview aggregates all 4 providers accurately
    const overview = getAdminBatchesOverview(db, {
      ANTHROPIC_API_KEY: 'a',
      GEMINI_API_KEY: 'g',
      OPENAI_API_KEY: 'o',
      ...vEnv,
    })
    expect(overview.byProvider).toHaveLength(4)
    expect(overview.summary.totalBatches).toBe(3)
    expect(overview.summary.totalSavedUsd).toBeGreaterThan(0)
    expect(overview.summary.totalBaselineUsd).toBeCloseTo(
      overview.summary.totalSpentUsd + overview.summary.totalSavedUsd,
      8,
    )
  })

  it('recovers stuck downloading jobs and dead-PID heavy-job-holds on startup, and protects downloading files in housekeeper', () => {
    const nowSec = 1_700_005_000
    db.prepare(
      `INSERT INTO batch_jobs (
        id, provider, requested_provider, model, status, external_batch_id,
        input_path, output_path, total_items, completed_items, failed_items,
        estimated_cost_usd, actual_cost_usd, saved_cost_usd, cost_recorded,
        created_at, updated_at
      ) VALUES ('batch_stuck_1', 'openai', 'auto', 'gpt-4o-mini', 'downloading', 'ext_1', 'batch/in.jsonl', 'store/batch/out.jsonl', 10, 0, 0, 0.01, NULL, 0.01, 0, ?, ?)`,
    ).run(nowSec, nowSec)

    // Housekeeper protects `downloading` files
    const hkMeta = inspectBatchJobsTable(db)
    expect(hkMeta.hasBatchJobsTable).toBe(true)
    expect(hkMeta.activeIdentifiers.has('batch_stuck_1')).toBe(true)
    expect(hkMeta.activeIdentifiers.has('in.jsonl')).toBe(true)

    // Seed an orphan heavy-job-hold with dead PID
    const holdPath = holdStorePath(tmpRoot)
    writeHoldStore(holdPath, {
      'alfred-batch': {
        startMs: nowSec * 1000,
        panes: [999999],
        jobs: {
          '999999:123': {
            pid: 999999,
            start: '123',
            label: 'batch:batch_stuck_1',
            state: 'running',
            firstSeenMs: nowSec * 1000,
            alerted: false,
          },
        },
      },
    })

    const rec = recoverStuckBatchJobs(db, tmpRoot, { isPidAliveFn: () => false, nowSec: nowSec + 60 })
    expect(rec.recoveredDownloadingJobs).toBe(1)
    expect(rec.cleanedOrphanHolds).toBe(1)
    expect(getBatchJobById(db, 'batch_stuck_1')?.status).toBe('running')
    expect(readHoldStore(holdPath)['alfred-batch']).toBeUndefined()
  })

  it('enforces pre-flight budget check before submitting batch', async () => {
    const relPath = writeCanonicalJsonl(tmpRoot, 'batch/big.jsonl', [
      { custom_id: 'b1', prompt: 'Hello', max_tokens: 16000 },
    ])
    // Tiny daily budget ($0.0001) should be rejected before any fetch call
    const mockFetch = vi.fn() as unknown as typeof fetch
    await expect(
      submitBatchJob({
        db,
        inputPath: relPath,
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        agentDailyLimitUsd: 0.0001,
        globalDailyLimitUsd: 15,
        projectRoot: tmpRoot,
        env: { ANTHROPIC_API_KEY: 'ant-key' },
        fetchImpl: mockFetch,
      }),
    ).rejects.toThrow(BudgetExceededError)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('evaluates provider-aware quota-gate in model-router without mutating raw replyText', async () => {
    const nowMs = Date.now()
    const advice = evaluateCliQuotaForBatch({
      provider: 'claude-cli',
      nowMs,
      workClass: 'background',
      snapshotOverride: {
        source: 'authoritative',
        generatedAtMs: nowMs - 60_000,
        windows: { '5h': { used_percent: 91, resets_at: Math.floor(nowMs / 1000) + 3600 } },
      },
    })
    expect(advice.action).toBe('defer')
    expect(advice.recommendBatch).toBe(true)
    expect(advice.suggestionHu).toContain('alfred-batch')

    const cliAgent: AlfredAgentDefinition = {
      id: 'alfred-architect',
      displayName: 'Alfred Architect',
      channelName: '#alfred-hq',
      discordChannelId: '111',
      provider: 'claude-cli',
      model: 'default',
      workspace: 'workspaces/alfred-architect',
      workspaceAbsPath: tmpRoot,
      memoryNamespace: 'alfred-architect',
      dailyBudgetUsd: 5,
      allowedUserIds: [],
      tools: [],
      resolvedSystemPrompt: '',
    }

    const rawJsonReply = '{"ok":true,"items":[1,2,3]}'
    const outcome = await runHybridAgentTurn({
      db,
      agent: cliAgent,
      globalDailyBudgetUsd: 15,
      userMessage: 'Return JSON',
      projectRoot: tmpRoot,
      quotaWorkClass: 'background',
      quotaSnapshotOverride: {
        source: 'authoritative',
        generatedAtMs: nowMs - 60_000,
        windows: { '5h': { used_percent: 92 } },
      },
      cliRunner: async () => ({
        content: rawJsonReply,
        model: 'claude-cli:default',
        provider: 'claude-cli',
        durationMs: 50,
        usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0 },
      }),
    })

    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      // Raw JSON replyText MUST remain completely untouched!
      expect(outcome.replyText).toBe(rawJsonReply)
      expect(() => JSON.parse(outcome.replyText)).not.toThrow()
      expect(outcome.quotaAdvice?.recommendBatch).toBe(true)
      expect(outcome.quotaAdvice?.pressure).toBe(92)
    }
  })
})
