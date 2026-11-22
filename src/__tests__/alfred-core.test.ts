import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createVerify, generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import {
  bootAlfredCore,
  buildPromptCachedMessages,
  clearVertexTokenCache,
  createServiceAccountJwtAssertion,
  evaluateCircuitBreaker,
  executeWhitelistedTool,
  getAgentByChannelId,
  getWhitelistedToolSchemas,
  handleAlfredDiscordMessage,
  isUserAllowedForAgent,
  loadAlfredAgentsConfig,
  mapWhitelistToClaudePermissions,
  recordModelTokenUsage,
  runHybridAgentTurn,
  splitDiscordMessagePreservingCodeBlocks,
  ToolNotAllowedError,
  WorkspaceBoundaryError,
} from '../alfred/index.js'

describe('Alfred Core (feat/alfred-core)', () => {
  let tempDir: string

  beforeEach(() => {
    clearVertexTokenCache()
    tempDir = mkdtempSync(join(tmpdir(), 'alfred-core-test-'))
    initDatabase(':memory:')
  })

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup error on Windows file locks
    }
  })

  describe('1. Sablonok, config/agents.json és SOUL.md betöltés', () => {
      it('loads the repository config/agents.json and resolves all 5 configured agents with their SOUL.md files', () => {
        const env = {
          DISCORD_CHANNEL_ALFRED_HQ: '1111111111111111111',
          DISCORD_CHANNEL_PROJ_HYPATIA: '2222222222222222222',
          DISCORD_CHANNEL_ALFRED_QA: '3333333333333333333',
          DISCORD_CHANNEL_ALFRED_SELF_DEV: '4444444444444444444',
          DISCORD_CHANNEL_ALFRED_OPS: '5555555555555555555',
          ALFRED_GLOBAL_DAILY_BUDGET_USD: '15',
        }
        const cfg = loadAlfredAgentsConfig({ env, provisionWorkspaces: true })
        expect(cfg.agents).toHaveLength(5)

        const architect = cfg.agents.find((a) => a.id === 'alfred-architect')!
        const coder = cfg.agents.find((a) => a.id === 'alfred-coder-hypatia')!
        const qa = cfg.agents.find((a) => a.id === 'alfred-qa')!
        const selfCoder = cfg.agents.find((a) => a.id === 'alfred-self-coder')!
        const ops = cfg.agents.find((a) => a.id === 'alfred-ops')!

        expect(architect.discordChannelId).toBe('1111111111111111111')
        expect(architect.provider).toBe('deepseek')
        expect(architect.tools).toEqual(['fs_read', 'memory'])
        expect(architect.soulFile).toBe('agents/alfred-architect/SOUL.md')
        expect(architect.resolvedSystemPrompt).toContain('Alfred Architect')
        expect(existsSync(architect.workspaceAbsPath)).toBe(true)

        expect(coder.discordChannelId).toBe('2222222222222222222')
        expect(coder.provider).toBe('deepseek')
        expect(coder.tools).toEqual(['bash', 'fs_read', 'fs_write', 'git', 'memory'])
        expect(coder.soulFile).toBe('agents/alfred-coder-hypatia/SOUL.md')
        expect(coder.resolvedSystemPrompt).toContain('Alfred Coder (Hypatia)')
        expect(existsSync(coder.workspaceAbsPath)).toBe(true)

        expect(qa.discordChannelId).toBe('3333333333333333333')
        expect(qa.provider).toBe('vertex-eu')
        expect(qa.tools).toEqual([])
        expect(qa.soulFile).toBe('agents/alfred-qa/SOUL.md')
        expect(qa.resolvedSystemPrompt).toContain('Alfred QA')
        expect(existsSync(qa.workspaceAbsPath)).toBe(true)

        expect(selfCoder.discordChannelId).toBe('4444444444444444444')
        expect(selfCoder.provider).toBe('deepseek')
        expect(selfCoder.model).toBe('deepseek-reasoner')
        expect(selfCoder.workspace).toBe('.')
        expect(selfCoder.maxToolIterations).toBe(12)
        expect(selfCoder.protectedPaths).toContain('src/alfred/circuit-breaker.ts')
        expect(selfCoder.protectedPaths).toContain('deploy/')
        expect(selfCoder.soulFile).toBe('agents/alfred-self-coder/SOUL.md')
        expect(selfCoder.resolvedSystemPrompt).toContain('Alfred Self-Coder')

        expect(ops.discordChannelId).toBe('5555555555555555555')
        expect(ops.tools).toEqual(['bash', 'fs_read', 'memory', 'cli_manage'])
        expect(ops.allowedBashCommands).toHaveLength(6)
        expect(ops.soulFile).toBe('agents/alfred-ops/SOUL.md')
        expect(ops.resolvedSystemPrompt).toContain('Alfred Ops')
      })

      it('places SOUL.md content into the very first system message for DeepSeek prompt-caching', () => {
        const cfg = loadAlfredAgentsConfig({
          env: {
            DISCORD_CHANNEL_ALFRED_HQ: '1111111111111111111',
            DISCORD_CHANNEL_PROJ_HYPATIA: '2222222222222222222',
            DISCORD_CHANNEL_ALFRED_QA: '3333333333333333333',
          },
          provisionWorkspaces: false,
        })
        const architect = cfg.agents[0]
        const msgs = buildPromptCachedMessages(
          architect,
          [
            { role: 'user', content: 'Korábbi kérdés' },
            { role: 'assistant', content: 'Korábbi válasz' },
          ],
          'Új architektúra kérdés',
        )

        expect(msgs[0].role).toBe('system')
        expect(msgs[0].content).toBe(architect.resolvedSystemPrompt)
        expect(msgs[1]).toEqual({ role: 'user', content: 'Korábbi kérdés' })
        expect(msgs[2]).toEqual({ role: 'assistant', content: 'Korábbi válasz' })
        expect(msgs[3]).toEqual({ role: 'user', content: 'Új architektúra kérdés' })
      })
    })

    describe('2. Hibrid Modell-Router (deepseek + vertex-eu)', () => {
      it('routes deepseek calls to OpenAI-compatible /chat/completions and records prompt_cache_hit_tokens', async () => {
        const cfg = loadAlfredAgentsConfig({
          env: {
            DISCORD_CHANNEL_ALFRED_HQ: '1111111111111111111',
            DISCORD_CHANNEL_PROJ_HYPATIA: '2222222222222222222',
            DISCORD_CHANNEL_ALFRED_QA: '3333333333333333333',
          },
          provisionWorkspaces: false,
        })
        const architect = cfg.agents.find((a) => a.id === 'alfred-architect')!

        const mockFetch = vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({
            model: 'deepseek-reasoner',
            choices: [
              {
                message: {
                  content: 'Architektúra terv kész.',
                },
              },
            ],
            usage: {
              prompt_tokens: 2000,
              completion_tokens: 400,
              prompt_cache_hit_tokens: 1600,
              prompt_cache_miss_tokens: 400,
              completion_tokens_details: { reasoning_tokens: 150 },
            },
          }),
        })

        const outcome = await runHybridAgentTurn({
          db: getDb(),
          agent: architect,
          globalDailyBudgetUsd: 15.0,
          userMessage: 'Készíts ADR dokumentumot!',
          env: { DEEPSEEK_API_KEY: 'sk-test-deepseek' },
          fetchImpl: mockFetch as unknown as typeof fetch,
          nowSec: 1763676000,
        })

        expect(outcome.ok).toBe(true)
        if (!outcome.ok) return
        expect(outcome.provider).toBe('deepseek')
        expect(outcome.replyText).toBe('Architektúra terv kész.')
        expect(outcome.totalUsage.cacheReadTokens).toBe(1600)
        expect(outcome.totalUsage.inputTokens).toBe(400)
        expect(outcome.totalUsage.outputTokens).toBe(400)
        expect(outcome.totalUsage.thinkingTokens).toBe(150)

        // Verify request body had SOUL.md as first system message and only whitelisted tools
        const [calledUrl, calledInit] = mockFetch.mock.calls[0]
        expect(calledUrl).toBe('https://api.deepseek.com/v1/chat/completions')
        const sentBody = JSON.parse(calledInit.body)
        expect(sentBody.messages[0].role).toBe('system')
        expect(sentBody.messages[0].content).toContain('Alfred Architect')
        expect(sentBody.tools.map((t: any) => t.function.name)).toEqual(['fs_read', 'memory'])
      })

      it('routes vertex-eu calls to EU regional endpoint and rejects non-EU regions (GDPR guard)', async () => {
        const cfg = loadAlfredAgentsConfig({
          env: {
            DISCORD_CHANNEL_ALFRED_HQ: '1111111111111111111',
            DISCORD_CHANNEL_PROJ_HYPATIA: '2222222222222222222',
            DISCORD_CHANNEL_ALFRED_QA: '3333333333333333333',
          },
          provisionWorkspaces: false,
        })
        const qaAgent = cfg.agents.find((a) => a.id === 'alfred-qa')!

        // Non-EU location must fail closed with GDPR_VIOLATION
        await expect(
          runHybridAgentTurn({
            db: getDb(),
            agent: qaAgent,
            globalDailyBudgetUsd: 15.0,
            userMessage: 'Ellenőrizd a kódot!',
            env: {
              VERTEX_EU_PROJECT_ID: 'eu-gdpr-proj',
              VERTEX_EU_LOCATION: 'us-central1',
              VERTEX_EU_ACCESS_TOKEN: 'ya29.test-token',
            },
            fetchImpl: vi.fn() as unknown as typeof fetch,
          }),
        ).rejects.toThrow(/GDPR_VIOLATION/)

        // Valid EU location succeeds and sends zero tools for alfred-qa
        const mockVertexFetch = vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [
              {
                content: {
                  parts: [{ text: 'QA Verdikt: APPROVED' }],
                },
              },
            ],
            usageMetadata: {
              promptTokenCount: 1000,
              candidatesTokenCount: 250,
              cachedContentTokenCount: 600,
            },
          }),
        })

        const outcome = await runHybridAgentTurn({
          db: getDb(),
          agent: qaAgent,
          globalDailyBudgetUsd: 15.0,
          userMessage: 'Ellenőrizd a kódot!',
          env: {
            VERTEX_EU_PROJECT_ID: 'eu-gdpr-proj',
            VERTEX_EU_LOCATION: 'europe-west1',
            VERTEX_EU_ACCESS_TOKEN: 'ya29.test-token',
          },
          fetchImpl: mockVertexFetch as unknown as typeof fetch,
          nowSec: 1763676000,
        })

        expect(outcome.ok).toBe(true)
        if (!outcome.ok) return
        expect(outcome.provider).toBe('vertex-eu')
        expect(outcome.replyText).toBe('QA Verdikt: APPROVED')
        expect(outcome.totalUsage.cacheReadTokens).toBe(600)
        expect(outcome.totalUsage.inputTokens).toBe(400)
        expect(outcome.totalUsage.outputTokens).toBe(250)

        const [vertexUrl, vertexInit] = mockVertexFetch.mock.calls[0]
        expect(vertexUrl).toContain('https://europe-west1-aiplatform.googleapis.com/v1/projects/eu-gdpr-proj/locations/europe-west1/')
        const sentPayload = JSON.parse(vertexInit.body)
        expect(sentPayload.tools).toBeUndefined() // Zero-tool agent!
        expect(sentPayload.systemInstruction.parts[0].text).toContain('Alfred QA')
      })

      it('routes vertex-eu "eu" multi-region via aiplatform.eu.rep.googleapis.com, filters thought parts, and rejects "global"', async () => {
        const cfg = loadAlfredAgentsConfig({
          env: {
            DISCORD_CHANNEL_ALFRED_HQ: '1111111111111111111',
            DISCORD_CHANNEL_PROJ_HYPATIA: '2222222222222222222',
            DISCORD_CHANNEL_ALFRED_QA: '3333333333333333333',
          },
          provisionWorkspaces: false,
        })
        const qaAgent = cfg.agents.find((a) => a.id === 'alfred-qa')!

        // Non-EU "global" endpoint must fail closed with GDPR_VIOLATION
        await expect(
          runHybridAgentTurn({
            db: getDb(),
            agent: qaAgent,
            globalDailyBudgetUsd: 15.0,
            userMessage: 'Ellenőrizd!',
            env: {
              VERTEX_EU_PROJECT_ID: 'eu-gdpr-proj',
              VERTEX_EU_LOCATION: 'global',
              VERTEX_EU_ACCESS_TOKEN: 'ya29.test-token',
            },
            fetchImpl: vi.fn() as unknown as typeof fetch,
          }),
        ).rejects.toThrow(/GDPR_VIOLATION/)

        const mockEuRepFetch = vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [
              {
                content: {
                  parts: [
                    { text: 'internal reasoning trace', thought: true },
                    { text: 'QA OK', thoughtSignature: 'sig-123' },
                  ],
                },
              },
            ],
            usageMetadata: {
              promptTokenCount: 200,
              candidatesTokenCount: 15,
              thoughtsTokenCount: 40,
              cachedContentTokenCount: 50,
            },
          }),
        })

        const outcome = await runHybridAgentTurn({
          db: getDb(),
          agent: qaAgent,
          globalDailyBudgetUsd: 15.0,
          userMessage: 'Ellenőrizd a Gemini 3 modellt!',
          env: {
            VERTEX_EU_PROJECT_ID: 'eu-gdpr-proj',
            VERTEX_EU_LOCATION: 'eu',
            VERTEX_EU_ACCESS_TOKEN: 'ya29.test-token',
          },
          fetchImpl: mockEuRepFetch as unknown as typeof fetch,
          nowSec: 1763676000,
        })

        expect(outcome.ok).toBe(true)
        if (!outcome.ok) return
        expect(outcome.model).toBe('gemini-3.8-flash')
        expect(outcome.replyText).toBe('QA OK')
        expect(outcome.totalUsage.thinkingTokens).toBe(40)
        expect(outcome.totalUsage.outputTokens).toBe(55)
        expect(outcome.totalUsage.cacheReadTokens).toBe(50)
        expect(outcome.totalUsage.inputTokens).toBe(150)

        const [calledUrl] = mockEuRepFetch.mock.calls[0]
        expect(calledUrl).toBe(
          'https://aiplatform.eu.rep.googleapis.com/v1/projects/eu-gdpr-proj/locations/eu/publishers/google/models/gemini-3.8-flash:generateContent',
        )
      })

      it('authenticates vertex-eu via GOOGLE_APPLICATION_CREDENTIALS RS256 JWT exchange and caches the token across calls', async () => {
        const cfg = loadAlfredAgentsConfig({
          env: {
            DISCORD_CHANNEL_ALFRED_HQ: '1111111111111111111',
            DISCORD_CHANNEL_PROJ_HYPATIA: '2222222222222222222',
            DISCORD_CHANNEL_ALFRED_QA: '3333333333333333333',
          },
          provisionWorkspaces: false,
        })
        const qaAgent = cfg.agents.find((a) => a.id === 'alfred-qa')!

        const { privateKey, publicKey } = generateKeyPairSync('rsa', {
          modulusLength: 2048,
          publicKeyEncoding: { type: 'spki', format: 'pem' },
          privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        })

        const saKey = {
          type: 'service_account',
          project_id: 'eu-sa-fallback-proj',
          private_key_id: 'key-123',
          private_key: privateKey,
          client_email: 'alfred-qa@eu-sa-fallback-proj.iam.gserviceaccount.com',
          token_uri: 'https://oauth2.googleapis.com/token',
        }
        const saPath = join(tempDir, 'sa-key.json')
        writeFileSync(saPath, JSON.stringify(saKey), 'utf-8')

        // Verify RS256 JWT assertion signature cryptographically
        const jwt = createServiceAccountJwtAssertion(saKey, 1763676000)
        const [hdrB64, payB64, sigB64] = jwt.split('.')
        const verifier = createVerify('RSA-SHA256')
        verifier.update(`${hdrB64}.${payB64}`)
        verifier.end()
        expect(verifier.verify(publicKey, Buffer.from(sigB64, 'base64url'))).toBe(true)

        const mockFetch = vi.fn(async (url: string | URL, _init?: RequestInit) => {
          const u = String(url)
          if (u === 'https://oauth2.googleapis.com/token') {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                access_token: 'ya29.mock-exchanged-token',
                expires_in: 3600,
                token_type: 'Bearer',
              }),
            } as Response
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({
              candidates: [{ content: { parts: [{ text: 'SA OK' }] } }],
              usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 },
            }),
          } as Response
        })

        const env = {
          GOOGLE_APPLICATION_CREDENTIALS: saPath,
          VERTEX_EU_LOCATION: 'europe-west1',
          VERTEX_EU_ACCESS_TOKEN: '',
          VERTEX_EU_PROJECT_ID: '',
        }

        const first = await runHybridAgentTurn({
          db: getDb(),
          agent: qaAgent,
          globalDailyBudgetUsd: 15.0,
          userMessage: 'Első kör',
          env,
          fetchImpl: mockFetch as unknown as typeof fetch,
          nowSec: 1763676000,
        })
        const second = await runHybridAgentTurn({
          db: getDb(),
          agent: qaAgent,
          globalDailyBudgetUsd: 15.0,
          userMessage: 'Második kör',
          env,
          fetchImpl: mockFetch as unknown as typeof fetch,
          nowSec: 1763676010,
        })

        expect(first.ok).toBe(true)
        expect(second.ok).toBe(true)

        // OAuth2 token endpoint called ONCE across two generateContent calls (cached!)
        const tokenCalls = mockFetch.mock.calls.filter(([u]) => String(u) === 'https://oauth2.googleapis.com/token')
        const vertexCalls = mockFetch.mock.calls.filter(([u]) => String(u).includes('europe-west1-aiplatform.googleapis.com'))
        expect(tokenCalls).toHaveLength(1)
        expect(vertexCalls).toHaveLength(2)

        expect(String(vertexCalls[0][0])).toContain('/projects/eu-sa-fallback-proj/locations/europe-west1/')
        const authHeader = (vertexCalls[0][1] as RequestInit).headers as Record<string, string>
        expect(authHeader.Authorization).toBe('Bearer ya29.mock-exchanged-token')
      })
    })

    describe('3. Valódi CostOps Költségfék (Circuit Breaker)', () => {
      it('blocks API calls when an agent reaches 100% of its daily limit and returns BUDGET_EXCEEDED', async () => {
        const db = getDb()
        const nowSec = 1763676000
        const cfg = loadAlfredAgentsConfig({
          env: {
            DISCORD_CHANNEL_ALFRED_HQ: '1111111111111111111',
            DISCORD_CHANNEL_PROJ_HYPATIA: '2222222222222222222',
            DISCORD_CHANNEL_ALFRED_QA: '3333333333333333333',
          },
          provisionWorkspaces: false,
        })
        const architect = { ...cfg.agents.find((a) => a.id === 'alfred-architect')!, dailyBudgetUsd: 1.0 }

        // Record 500,000 output tokens on deepseek-reasoner ($2.19 / 1M => $1.095 > $1.00 daily limit)
        recordModelTokenUsage({
          db,
          agentId: architect.id,
          sessionId: 'test-session-1',
          model: 'deepseek-reasoner',
          provider: 'deepseek',
          inputTokens: 0,
          outputTokens: 500_000,
          timestampSec: nowSec - 60,
        })

        const mockFetch = vi.fn()
        const outcome = await runHybridAgentTurn({
          db,
          agent: architect,
          globalDailyBudgetUsd: 15.0,
          userMessage: 'Folytasd a tervezést!',
          env: { DEEPSEEK_API_KEY: 'sk-test' },
          fetchImpl: mockFetch as unknown as typeof fetch,
          nowSec,
        })

        // The LLM API must NOT be called at all!
        expect(mockFetch).not.toHaveBeenCalled()
        expect(outcome.ok).toBe(false)
        if (outcome.ok) return
        expect(outcome.code).toBe('BUDGET_EXCEEDED')
        if (outcome.code !== 'BUDGET_EXCEEDED') return
        expect(outcome.evaluation.reason).toBe('agent_daily_limit')
        expect(outcome.discordMessage).toContain('BUDGET_EXCEEDED')
        expect(outcome.discordMessage).toContain('alfred-architect')
      })

      it('blocks API calls mid-tool-loop if iteration 1 pushes global spend to 100%', async () => {
        const db = getDb()
        const nowSec = 1763676000
        const cfg = loadAlfredAgentsConfig({
          env: {
            DISCORD_CHANNEL_ALFRED_HQ: '1111111111111111111',
            DISCORD_CHANNEL_PROJ_HYPATIA: '2222222222222222222',
            DISCORD_CHANNEL_ALFRED_QA: '3333333333333333333',
          },
          provisionWorkspaces: false,
        })
        const architect = {
          ...cfg.agents.find((a) => a.id === 'alfred-architect')!,
          workspaceAbsPath: join(tempDir, 'ws-arch'),
          dailyBudgetUsd: 10.0,
        }

        // Iteration 1 returns a tool call (`memory` read) and consumes 1,000,000 output tokens ($2.19),
        // exceeding the $2.00 global daily budget before Iteration 2 can call the LLM again.
        const mockFetch = vi.fn().mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            model: 'deepseek-reasoner',
            choices: [
              {
                message: {
                  content: '',
                  tool_calls: [
                    {
                      id: 'call_1',
                      type: 'function',
                      function: { name: 'memory', arguments: JSON.stringify({ action: 'read' }) },
                    },
                  ],
                },
              },
            ],
            usage: {
              prompt_tokens: 1000,
              completion_tokens: 1_000_000,
            },
          }),
        })

        const outcome = await runHybridAgentTurn({
          db,
          agent: architect,
          globalDailyBudgetUsd: 2.0,
          userMessage: 'Olvasd ki a memóriát és elemezd!',
          env: { DEEPSEEK_API_KEY: 'sk-test' },
          fetchImpl: mockFetch as unknown as typeof fetch,
          nowSec,
        })

        expect(mockFetch).toHaveBeenCalledTimes(1)
        expect(outcome.ok).toBe(false)
        if (outcome.ok) return
        expect(outcome.code).toBe('BUDGET_EXCEEDED')
        if (outcome.code !== 'BUDGET_EXCEEDED') return
        expect(outcome.evaluation.reason).toBe('global_daily_limit')
      })
    })

    describe('4. Ágensenkénti Tool Whitelist és Workspace Izoláció', () => {
      it('enforces tool whitelist per agent (Architect, Coder, Zero-Tool QA)', () => {
        const db = getDb()
        const wsArch = join(tempDir, 'workspaces', 'alfred-architect')
        const wsCoder = join(tempDir, 'workspaces', 'hypatia')
        const wsQa = join(tempDir, 'workspaces', 'alfred-qa')
        mkdirSync(wsArch, { recursive: true })
        mkdirSync(wsCoder, { recursive: true })
        mkdirSync(wsQa, { recursive: true })

        const cfg = loadAlfredAgentsConfig({
          env: {
            DISCORD_CHANNEL_ALFRED_HQ: '1111111111111111111',
            DISCORD_CHANNEL_PROJ_HYPATIA: '2222222222222222222',
            DISCORD_CHANNEL_ALFRED_QA: '3333333333333333333',
          },
          provisionWorkspaces: false,
        })
        const architect = { ...cfg.agents[0], workspaceAbsPath: wsArch }
        const coder = { ...cfg.agents[1], workspaceAbsPath: wsCoder }
        const qa = { ...cfg.agents[2], workspaceAbsPath: wsQa }

        // Schema-level filtering
        expect(getWhitelistedToolSchemas(architect).map((s) => s.function.name)).toEqual(['fs_read', 'memory'])
        expect(getWhitelistedToolSchemas(coder).map((s) => s.function.name)).toEqual([
          'bash',
          'fs_read',
          'fs_write',
          'git',
          'memory',
        ])
        expect(getWhitelistedToolSchemas(qa)).toEqual([])

        // Runtime enforcement: Architect cannot call fs_write or bash
        expect(() =>
          executeWhitelistedTool({ agent: architect, db }, 'fs_write', { path: 'a.txt', content: 'x' }),
        ).toThrow(ToolNotAllowedError)
        expect(() =>
          executeWhitelistedTool({ agent: architect, db }, 'bash', { command: 'echo hi' }),
        ).toThrow(ToolNotAllowedError)

        // Runtime enforcement: Zero-tool QA cannot call any tool, even fs_read or memory
        expect(() =>
          executeWhitelistedTool({ agent: qa, db }, 'fs_read', { path: '.' }),
        ).toThrow(ToolNotAllowedError)
        expect(() =>
          executeWhitelistedTool({ agent: qa, db }, 'memory', { action: 'read' }),
        ).toThrow(ToolNotAllowedError)

        // Runtime enforcement: Coder can write and read inside its own workspace
        const writeRes = executeWhitelistedTool({ agent: coder, db }, 'fs_write', {
          path: 'src/app.ts',
          content: 'export const x = 42;\n',
        })
        expect(writeRes).toContain('OK:')
        const readRes = executeWhitelistedTool({ agent: coder, db }, 'fs_read', { path: 'src/app.ts' })
        expect(readRes).toBe('export const x = 42;\n')

        // Workspace boundary enforcement: Coder cannot escape workspace via ../
        expect(() =>
          executeWhitelistedTool({ agent: coder, db }, 'fs_read', { path: '../alfred-architect/secret.txt' }),
        ).toThrow(WorkspaceBoundaryError)

        // Git policy enforcement: Coder cannot checkout or push to main/master
        expect(() =>
          executeWhitelistedTool({ agent: coder, db }, 'git', { args: ['checkout', 'main'] }),
        ).toThrow(/GIT_POLICY_VIOLATION/)
        expect(() =>
          executeWhitelistedTool({ agent: coder, db }, 'git', { args: ['push', 'origin', 'main'] }),
        ).toThrow(/GIT_POLICY_VIOLATION/)

        // Claude Code permissions mapper
        const qaPerms = mapWhitelistToClaudePermissions(qa.tools, wsQa)
        expect(qaPerms.allow).toEqual([])
        expect(qaPerms.deny).toContain('Read')
        expect(qaPerms.deny).toContain('Write')
        expect(qaPerms.deny).toContain('Bash')
      })

      it('isolates SQLite memory namespaces so agents cannot read each other’s memories', () => {
        const db = getDb()
        const cfg = loadAlfredAgentsConfig({
          env: {
            DISCORD_CHANNEL_ALFRED_HQ: '1111111111111111111',
            DISCORD_CHANNEL_PROJ_HYPATIA: '2222222222222222222',
            DISCORD_CHANNEL_ALFRED_QA: '3333333333333333333',
          },
          provisionWorkspaces: false,
        })
        const architect = cfg.agents[0]
        const coder = cfg.agents[1]

        executeWhitelistedTool({ agent: architect, db }, 'memory', {
          action: 'save',
          content: 'Architect titkos ADR döntés #1',
          category: 'hot',
        })
        executeWhitelistedTool({ agent: coder, db }, 'memory', {
          action: 'save',
          content: 'Hypatia Coder implementációs jegyzet #2',
          category: 'warm',
        })

        const archMemories = executeWhitelistedTool({ agent: architect, db }, 'memory', { action: 'read' })
        const coderMemories = executeWhitelistedTool({ agent: coder, db }, 'memory', { action: 'read' })

        expect(archMemories).toContain('Architect titkos ADR döntés #1')
        expect(archMemories).not.toContain('Hypatia Coder implementációs jegyzet #2')

        expect(coderMemories).toContain('Hypatia Coder implementációs jegyzet #2')
        expect(coderMemories).not.toContain('Architect titkos ADR döntés #1')
      })
    })

    describe('5. Több-felhasználós, Csatorna-alapú Discord-adapter és Kódblokk-darabolás', () => {
      it('supports multiple ALLOWED_USER_IDS globally and per-agent, and routes channels to the right agent', async () => {
        const db = getDb()
        const env = {
          ALLOWED_USER_IDS: '100000000000000001,100000000000000002',
          DISCORD_CHANNEL_ALFRED_HQ: '1111111111111111111',
          DISCORD_CHANNEL_PROJ_HYPATIA: '2222222222222222222',
          DISCORD_CHANNEL_ALFRED_QA: '3333333333333333333',
          DEEPSEEK_API_KEY: 'sk-test-key',
        }
        const cfg = loadAlfredAgentsConfig({ env, provisionWorkspaces: false })

        expect(isUserAllowedForAgent('100000000000000001', cfg.agents[0], ['100000000000000001', '100000000000000002'])).toBe(true)
        expect(isUserAllowedForAgent('100000000000000002', cfg.agents[0], ['100000000000000001', '100000000000000002'])).toBe(true)
        expect(isUserAllowedForAgent('999999999999999999', cfg.agents[0], ['100000000000000001', '100000000000000002'])).toBe(false)

        expect(getAgentByChannelId(cfg, '1111111111111111111')?.id).toBe('alfred-architect')
        expect(getAgentByChannelId(cfg, '2222222222222222222')?.id).toBe('alfred-coder-hypatia')
        expect(getAgentByChannelId(cfg, '3333333333333333333')?.id).toBe('alfred-qa')

        const sentMessages: Array<{ channelId: string; text: string }> = []
        const sendToDiscord = async (channelId: string, text: string) => {
          sentMessages.push({ channelId, text })
        }

        // Unauthorized user is rejected before calling the model
        const deniedRes = await handleAlfredDiscordMessage({
          db,
          agentsConfig: cfg,
          env,
          sendToDiscord,
          message: {
            channelId: '2222222222222222222',
            userId: '999999999999999999',
            messageId: 'msg-unauth-1',
            content: 'Törölj mindent!',
          },
        })
        expect(deniedRes.status).toBe('denied_unauthorized_user')
        expect(sentMessages).toHaveLength(0)

        // Authorized user #2 in #proj-hypatia is routed to alfred-coder-hypatia
        const mockFetch = vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({
            model: 'deepseek-chat',
            choices: [{ message: { content: 'Hypatia modul kész.' } }],
            usage: { prompt_tokens: 300, completion_tokens: 50, prompt_cache_hit_tokens: 250, prompt_cache_miss_tokens: 50 },
          }),
        })

        const okRes = await handleAlfredDiscordMessage({
          db,
          agentsConfig: cfg,
          env,
          sendToDiscord,
          fetchImpl: mockFetch as unknown as typeof fetch,
          message: {
            channelId: '2222222222222222222',
            userId: '100000000000000002',
            messageId: 'msg-auth-2',
            content: 'Implementáld a Hypatia modult!',
          },
        })

        expect(okRes.status).toBe('replied')
        expect(sentMessages).toEqual([{ channelId: '2222222222222222222', text: 'Hypatia modul kész.' }])
      })

      it('sends BUDGET_EXCEEDED directly to the Discord channel when Circuit Breaker trips', async () => {
        const db = getDb()
        const nowSec = 1763676000
        const env = {
          ALLOWED_USER_IDS: '100000000000000001',
          DISCORD_CHANNEL_ALFRED_HQ: '1111111111111111111',
          DISCORD_CHANNEL_PROJ_HYPATIA: '2222222222222222222',
          DISCORD_CHANNEL_ALFRED_QA: '3333333333333333333',
          DEEPSEEK_API_KEY: 'sk-test-key',
        }
        const cfg = loadAlfredAgentsConfig({ env, provisionWorkspaces: false })

        // Exhaust alfred-architect's $5.00 daily budget
        recordModelTokenUsage({
          db,
          agentId: 'alfred-architect',
          sessionId: 'sess-exhaust',
          model: 'deepseek-reasoner',
          provider: 'deepseek',
          inputTokens: 0,
          outputTokens: 3_000_000, // $6.57 > $5.00
          timestampSec: nowSec - 10,
        })

        const sentMessages: Array<{ channelId: string; text: string }> = []
        const res = await handleAlfredDiscordMessage({
          db,
          agentsConfig: cfg,
          env,
          nowSec,
          sendToDiscord: async (channelId, text) => {
            sentMessages.push({ channelId, text })
          },
          message: {
            channelId: '1111111111111111111',
            userId: '100000000000000001',
            messageId: 'msg-over-budget',
            content: 'Újabb kérés',
          },
        })

        expect(res.status).toBe('blocked_budget_exceeded')
        expect(sentMessages).toHaveLength(1)
        expect(sentMessages[0].channelId).toBe('1111111111111111111')
        expect(sentMessages[0].text).toContain('BUDGET_EXCEEDED')
        expect(sentMessages[0].text).toContain('alfred-architect')
      })

      it('chunks responses longer than 2000 characters while keeping Markdown code blocks intact', () => {
        const codeLines = Array.from({ length: 80 }, (_, i) => `const line_${i} = "érték_${i}_" + ${i * 100};`)
        const longResponse = [
          'Itt a kért TypeScript implementáció:',
          '```typescript',
          ...codeLines,
          '```',
          'Minden teszt zöld!',
        ].join('\n')

        expect(longResponse.length).toBeGreaterThan(2000)
        const chunks = splitDiscordMessagePreservingCodeBlocks(longResponse, 2000)
        expect(chunks.length).toBeGreaterThan(1)

        for (const chunk of chunks) {
          expect(chunk.length).toBeLessThanOrEqual(2000)
          // Every chunk that opens a code fence must also close it!
          const fenceMatches = chunk.match(/```/g) ?? []
          expect(fenceMatches.length % 2).toBe(0)
        }
        expect(chunks[0]).toContain('```typescript')
        expect(chunks[0].trimEnd().endsWith('```')).toBe(true)
        expect(chunks[1].startsWith('```typescript')).toBe(true)
      })

      it('syncs ALLOWED_USER_IDS and agent Discord channels into access.json on bootAlfredCore', () => {
        const discordDir = join(tempDir, 'discord-state')
        const env = {
          ALLOWED_USER_IDS: '100000000000000001,100000000000000002',
          DISCORD_CHANNEL_ALFRED_HQ: '1111111111111111111',
          DISCORD_CHANNEL_PROJ_HYPATIA: '2222222222222222222',
          DISCORD_CHANNEL_ALFRED_QA: '3333333333333333333',
          DISCORD_CHANNEL_ALFRED_SELF_DEV: '4444444444444444444',
          DISCORD_CHANNEL_ALFRED_OPS: '5555555555555555555',
        }
        const cfg = bootAlfredCore({ env, discordDir, provisionWorkspaces: false })
        expect(cfg).not.toBeNull()

        const accessJson = JSON.parse(readFileSync(join(discordDir, 'access.json'), 'utf-8'))
        expect(accessJson.allowFrom).toEqual(['100000000000000001', '100000000000000002'])
        expect(Object.keys(accessJson.groups)).toEqual([
          '1111111111111111111',
          '2222222222222222222',
          '3333333333333333333',
          '4444444444444444444',
          '5555555555555555555',
        ])
        expect(accessJson.groups['1111111111111111111'].allowFrom).toEqual([
          '100000000000000001',
          '100000000000000002',
        ])
      })

      it('preserves Gemini 3 thoughtSignature across Vertex AI EU multi-turn functionCall loops', async () => {
        const db = getDb()
        const ws = join(tempDir, 'ws-vertex-sig')
        mkdirSync(ws, { recursive: true })
        const sentPayloads: Array<Record<string, unknown>> = []

        const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
          sentPayloads.push(body)
          if (sentPayloads.length === 1) {
            return new Response(
              JSON.stringify({
                candidates: [
                  {
                    content: {
                      parts: [
                        {
                          functionCall: { name: 'memory', args: { action: 'read' } },
                          thoughtSignature: 'sig-gemini3-test-xyz',
                        },
                      ],
                    },
                  },
                ],
                usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 10 },
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            )
          }
          return new Response(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [{ text: 'Kész a Vertex válasz.' }],
                  },
                },
              ],
              usageMetadata: { promptTokenCount: 140, candidatesTokenCount: 15 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        })

        const outcome = await runHybridAgentTurn({
          db,
          agent: {
            id: 'vertex-sig-agent',
            displayName: 'Vertex Sig Agent',
            channelName: '#vertex-sig',
            discordChannelId: '777777777777777777',
            provider: 'vertex-eu',
            model: 'gemini-3.8-flash',
            workspace: 'workspaces/vertex-sig',
            workspaceAbsPath: ws,
            memoryNamespace: 'vertex-sig-agent',
            dailyBudgetUsd: 5,
            allowedUserIds: ['111111111111111111'],
            tools: ['memory'],
            resolvedSystemPrompt: 'Teszt.',
          },
          globalDailyBudgetUsd: 10,
          userMessage: 'Olvasd ki a memóriát!',
          env: {
            VERTEX_EU_ACCESS_TOKEN: 'ya29.test-token',
            VERTEX_EU_PROJECT_ID: 'eu-test-proj',
            VERTEX_EU_LOCATION: 'eu',
          },
          fetchImpl: mockFetch as unknown as typeof fetch,
        })

        expect(outcome.ok).toBe(true)
        if (outcome.ok) {
          expect(outcome.replyText).toBe('Kész a Vertex válasz.')
        }
        expect(sentPayloads).toHaveLength(2)
        const secondContents = sentPayloads[1]['contents'] as Array<{
          role: string
          parts: Array<{ functionCall?: { name: string }; thoughtSignature?: string }>
        }>
        const modelTurn = secondContents.find((c) => c.role === 'model')
        expect(modelTurn?.parts[0]?.functionCall?.name).toBe('memory')
        expect(modelTurn?.parts[0]?.thoughtSignature).toBe('sig-gemini3-test-xyz')
      })
    })
  })
