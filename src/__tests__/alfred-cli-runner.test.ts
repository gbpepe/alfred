import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentSpend } from '../costops/agent-budgets.js'
import { getDb, initDatabase } from '../db.js'
import {
  buildCliCommandSpec,
  buildSanitizedCliEnv,
  checkCliProvidersHealth,
  classifyCliError,
  CliExecutionError,
  CliExecutionQueue,
  CliManagerValidationError,
  detectCliAuthStatus,
  evaluateCircuitBreaker,
  executeWhitelistedToolAsync,
  extractCliLoginUrl,
  extractCodexDeviceCode,
  getCliInventory,
  getCliQueueStats,
  handleAlfredDiscordMessage,
  installOrUpdateCli,
  loadAlfredAgentsConfig,
  logoutCli,
  normalizeManagedCliId,
  parseSubmittedLoginInput,
  ProtectedPathError,
  removeCli,
  resetDefaultCliQueue,
  resolveEffectiveTokenPrices,
  runCliAgent,
  runHybridAgentTurn,
  sanitizeCliText,
  saveCliCredentials,
  spawnCliProcess,
  ToolNotAllowedError,
  type AlfredAgentDefinition,
  type CliProcessRunner,
  type CliSpawnRequest,
} from '../alfred/index.js'
import { tryHandleAlfredVps } from '../web/routes/alfred-vps.js'
import type { RouteContext } from '../web/routes/types.js'

function makeCliAgent(overrides: Partial<AlfredAgentDefinition> & { workspaceAbsPath: string }): AlfredAgentDefinition {
  return {
    id: 'test-cli-agent',
    displayName: 'Test CLI Agent',
    channelName: '#test-cli',
    discordChannelId: '999999999999999999',
    provider: 'claude-cli',
    model: 'default',
    workspace: 'workspaces/test-cli',
    memoryNamespace: 'test-cli-agent',
    dailyBudgetUsd: 5.0,
    allowedUserIds: ['111111111111111111'],
    tools: ['fs_read', 'fs_write', 'bash', 'git', 'memory'],
    resolvedSystemPrompt: 'Te vagy a teszt CLI ágens.',
    ...overrides,
  }
}

function initTempGitRepo(rootDir: string): void {
  execFileSync('git', ['init'], { cwd: rootDir, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'test@alfred.local'], { cwd: rootDir, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'Alfred Test'], { cwd: rootDir, stdio: 'ignore' })
  mkdirSync(join(rootDir, 'config'), { recursive: true })
  mkdirSync(join(rootDir, 'deploy'), { recursive: true })
  mkdirSync(join(rootDir, 'src'), { recursive: true })
  mkdirSync(join(rootDir, 'store'), { recursive: true })
  writeFileSync(join(rootDir, '.gitignore'), '.env\nstore/\n', 'utf-8')
  writeFileSync(join(rootDir, 'config', 'agents.json'), '{"version":1,"agents":[]}\n', 'utf-8')
  writeFileSync(join(rootDir, 'src', 'app.ts'), 'export const v = 1\n', 'utf-8')
  writeFileSync(join(rootDir, '.env'), 'DISCORD_BOT_TOKEN=super-secret-token\n', 'utf-8')
  writeFileSync(join(rootDir, 'store', 'secrets.json'), '{"key":"abc"}\n', 'utf-8')
  execFileSync('git', ['add', '.gitignore', 'config/agents.json', 'src/app.ts'], { cwd: rootDir, stdio: 'ignore' })
  execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: rootDir, stdio: 'ignore' })
}

describe('Alfred Headless CLI Runner (cli-runner.ts)', () => {
  let tempDir: string

  beforeEach(() => {
    resetDefaultCliQueue()
    tempDir = mkdtempSync(join(tmpdir(), 'alfred-cli-runner-'))
    initDatabase(':memory:')
  })

  afterEach(() => {
    resetDefaultCliQueue()
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore Windows cleanup races
    }
  })

  describe('1. Parancs-összeállítás és JSON/JSONL parszolás', () => {
    it('builds claude-cli argv with system prompt, permissions, omits --model on default, and parses JSON usage', async () => {
      const ws = join(tempDir, 'ws-claude')
      mkdirSync(ws, { recursive: true })
      const agent = makeCliAgent({
        provider: 'claude-cli',
        model: 'default',
        workspaceAbsPath: ws,
        tools: ['fs_read', 'memory'],
        protectedPaths: ['.env'],
      })

      let captured: CliSpawnRequest | null = null
      const runner: CliProcessRunner = async (req) => {
        captured = req
        return {
          stdout: JSON.stringify({
            type: 'result',
            result: 'Elemzés kész.',
            model: 'claude-sonnet-4-5',
            usage: {
              input_tokens: 120,
              output_tokens: 45,
              cache_read_input_tokens: 800,
              cache_creation_input_tokens: 50,
            },
          }),
          stderr: '',
          exitCode: 0,
          signal: null,
          timedOut: false,
        }
      }

      const res = await runCliAgent({
        agent,
        userMessage: 'Elemezd a repót!',
        env: { PATH: process.env.PATH, ALFRED_CLAUDE_BIN: '/opt/bin/claude' },
        processRunner: runner,
      })

      expect(captured).not.toBeNull()
      expect(captured!.command).toBe('/opt/bin/claude')
      expect(captured!.cwd).toBe(ws)
      expect(captured!.args).toContain('-p')
      expect(captured!.args).toContain('--output-format')
      expect(captured!.args).toContain('json')
      expect(captured!.args).toContain('--append-system-prompt')
      expect(captured!.args).not.toContain('--model')
      expect(captured!.args).toContain('--allowedTools')
      expect(captured!.args).toContain('--disallowedTools')

      expect(res.content).toBe('Elemzés kész.')
      expect(res.model).toBe('claude-cli:claude-sonnet-4-5')
      expect(res.usage).toEqual({
        inputTokens: 120,
        outputTokens: 45,
        cacheReadTokens: 800,
        cacheCreationTokens: 50,
        thinkingTokens: 0,
      })
    })

    it('builds codex-cli with workspace-write vs read-only sandbox and parses JSONL stream', async () => {
      const ws = join(tempDir, 'ws-codex')
      mkdirSync(ws, { recursive: true })

      const roAgent = makeCliAgent({
        provider: 'codex-cli',
        model: 'default',
        workspaceAbsPath: ws,
        tools: ['fs_read'],
      })
      const roSpec = buildCliCommandSpec({ agent: roAgent, userMessage: 'Olvass!', env: {} })
      expect(roSpec.command).toBe('codex')
      expect(roSpec.args.slice(0, 4)).toEqual(['exec', '--json', '--sandbox', 'read-only'])
      expect(roSpec.args).not.toContain('-m')

      const rwAgent = makeCliAgent({
        provider: 'codex-cli',
        model: 'o4-mini',
        workspaceAbsPath: ws,
        tools: ['fs_read', 'fs_write'],
      })

      let capturedArgs: string[] = []
      const res = await runCliAgent({
        agent: rwAgent,
        userMessage: 'Írj tesztet!',
        env: { PATH: process.env.PATH },
        processRunner: async (req) => {
          capturedArgs = req.args
          const jsonl = [
            'not-json-banner-line',
            JSON.stringify({ type: 'thread.started', model: 'o4-mini' }),
            JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Első gondolat' } }),
            JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Végső Codex válasz' } }),
            JSON.stringify({
              type: 'turn.completed',
              usage: { input_tokens: 500, cached_input_tokens: 200, output_tokens: 75 },
            }),
          ].join('\n')
          return { stdout: jsonl, stderr: '', exitCode: 0, signal: null, timedOut: false }
        },
      })

      expect(capturedArgs.slice(0, 6)).toEqual(['exec', '--json', '--sandbox', 'workspace-write', '-m', 'o4-mini'])
      expect(res.content).toBe('Végső Codex válasz')
      expect(res.model).toBe('codex-cli:o4-mini')
      expect(res.usage).toEqual({
        inputTokens: 300,
        outputTokens: 75,
        cacheReadTokens: 200,
        cacheCreationTokens: 0,
        thinkingTokens: 0,
      })
    })

    it('builds gemini-cli with auto_edit for writers, omits auto_edit for readers, and falls back to char estimates when stats missing', async () => {
      const ws = join(tempDir, 'ws-gemini')
      mkdirSync(ws, { recursive: true })

      const readerAgent = makeCliAgent({
        provider: 'gemini-cli',
        model: 'gemini-2.5-flash',
        workspaceAbsPath: ws,
        tools: [],
      })
      const readerSpec = buildCliCommandSpec({ agent: readerAgent, userMessage: 'Review', env: {} })
      expect(readerSpec.args).toContain('-m')
      expect(readerSpec.args).toContain('gemini-2.5-flash')
      expect(readerSpec.args).not.toContain('--approval-mode')

      const writerAgent = makeCliAgent({
        provider: 'gemini-cli',
        model: 'default',
        workspaceAbsPath: ws,
        tools: ['fs_write'],
      })

      let writerArgs: string[] = []
      const resWithStats = await runCliAgent({
        agent: writerAgent,
        userMessage: 'Implementálj',
        env: {},
        processRunner: async (req) => {
          writerArgs = req.args
          return {
            stdout: JSON.stringify({
              response: 'Gemini kész válasz',
              stats: {
                models: {
                  'gemini-2.5-pro': {
                    tokens: { prompt: 400, cached: 100, candidates: 60, thoughts: 20 },
                  },
                },
              },
            }),
            stderr: '',
            exitCode: 0,
            signal: null,
            timedOut: false,
          }
        },
      })

      expect(writerArgs).toContain('--approval-mode')
      expect(writerArgs).toContain('auto_edit')
      expect(writerArgs).not.toContain('-m')
      expect(resWithStats.content).toBe('Gemini kész válasz')
      expect(resWithStats.model).toBe('gemini-cli:gemini-2.5-pro')
      expect(resWithStats.usage).toEqual({
        inputTokens: 300,
        outputTokens: 80,
        cacheReadTokens: 100,
        cacheCreationTokens: 0,
        thinkingTokens: 20,
      })

      // Missing stats -> character-based token fallback
      const resFallbackUsage = await runCliAgent({
        agent: readerAgent,
        userMessage: '12345678',
        env: {},
        processRunner: async () => ({
          stdout: JSON.stringify({ response: '123456789012' }),
          stderr: '',
          exitCode: 0,
          signal: null,
          timedOut: false,
        }),
      })
      expect(resFallbackUsage.usage.inputTokens).toBeGreaterThan(0)
      expect(resFallbackUsage.usage.outputTokens).toBe(3)
    })

    it('trims oldest conversationHistory turns when ALFRED_CLI_MAX_PROMPT_CHARS is exceeded', () => {
      const ws = join(tempDir, 'ws-trim')
      mkdirSync(ws, { recursive: true })
      const agent = makeCliAgent({
        provider: 'gemini-cli',
        workspaceAbsPath: ws,
        resolvedSystemPrompt: 'SYSTEM_CORE',
      })
      const history = [
        { role: 'user' as const, content: 'OLDEST_1_' + 'x'.repeat(300) },
        { role: 'assistant' as const, content: 'OLDEST_2_' + 'y'.repeat(300) },
        { role: 'user' as const, content: 'RECENT_TURN' },
      ]
      const spec = buildCliCommandSpec({
        agent,
        userMessage: 'FINAL_QUESTION',
        conversationHistory: history,
        env: { ALFRED_CLI_MAX_PROMPT_CHARS: '500' },
      })
      expect(spec.promptText).toContain('SYSTEM_CORE')
      expect(spec.promptText).toContain('FINAL_QUESTION')
      expect(spec.promptText).toContain('RECENT_TURN')
      expect(spec.promptText).not.toContain('OLDEST_1_')
    })
  })

  describe('2. Globális Mutex (CliExecutionQueue), metrikák és timeout', () => {
    it('serializes concurrent CLI calls in FIFO order, reports queue stats, and releases lock on error', async () => {
      const ws = join(tempDir, 'ws-mutex')
      mkdirSync(ws, { recursive: true })
      const agent = makeCliAgent({ provider: 'claude-cli', workspaceAbsPath: ws, tools: ['fs_read'] })

      let inFlight = 0
      let maxInFlight = 0
      const order: string[] = []
      const queuedPositions: number[] = []
      let statsWhileRunning = { active: 0, queued: 0, maxConcurrency: 1 }

      const runner: CliProcessRunner = async (req) => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        const promptArg = req.args[req.args.indexOf('-p') + 1]
        order.push(`start:${promptArg}`)
        if (promptArg === 'task-1') {
          await new Promise((r) => setTimeout(r, 35))
          statsWhileRunning = getCliQueueStats()
        }
        inFlight -= 1
        order.push(`end:${promptArg}`)
        if (promptArg === 'task-2-fail') {
          return { stdout: '', stderr: 'boom', exitCode: 1, signal: null, timedOut: false }
        }
        return {
          stdout: JSON.stringify({ result: `ok:${promptArg}` }),
          stderr: '',
          exitCode: 0,
          signal: null,
          timedOut: false,
        }
      }

      const p1 = runCliAgent({ agent, userMessage: 'task-1', env: {}, processRunner: runner })
      const p2 = runCliAgent({
        agent,
        userMessage: 'task-2-fail',
        env: {},
        processRunner: runner,
        onQueued: (pos) => queuedPositions.push(pos),
      })
      const p3 = runCliAgent({
        agent,
        userMessage: 'task-3',
        env: {},
        processRunner: runner,
        onQueued: (pos) => queuedPositions.push(pos),
      })

      const [r1, r2, r3] = await Promise.allSettled([p1, p2, p3])
      expect(maxInFlight).toBe(1)
      expect(queuedPositions).toEqual([1, 2])
      expect(statsWhileRunning).toEqual({ active: 1, queued: 2, maxConcurrency: 1 })
      expect(order).toEqual([
        'start:task-1',
        'end:task-1',
        'start:task-2-fail',
        'end:task-2-fail',
        'start:task-3',
        'end:task-3',
      ])
      expect(r1.status).toBe('fulfilled')
      expect(r2.status).toBe('rejected')
      expect(r3.status).toBe('fulfilled')
      expect(getCliQueueStats()).toEqual({ active: 0, queued: 0, maxConcurrency: 1 })
    })

    it('terminates a hanging subprocess cleanly on timeout (SIGTERM -> SIGKILL) and classifies TIMEOUT', async () => {
      const ws = join(tempDir, 'ws-timeout')
      mkdirSync(ws, { recursive: true })
      const agent = makeCliAgent({
        provider: 'claude-cli',
        workspaceAbsPath: ws,
        cliTimeoutMs: 120,
      })

      const queue = new CliExecutionQueue(1)
      // Real subprocess that sleeps indefinitely until killed
      const res = await spawnCliProcess({
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: ws,
        env: { PATH: process.env.PATH ?? '' },
        timeoutMs: 120,
        killGraceMs: 80,
        maxOutputBytes: 1024 * 64,
      })
      expect(res.timedOut).toBe(true)

      await expect(
        runCliAgent({
          agent,
          userMessage: 'hang',
          env: {},
          queue,
          processRunner: async () => ({
            stdout: '',
            stderr: '',
            exitCode: null,
            signal: 'SIGKILL',
            timedOut: true,
          }),
        }),
      ).rejects.toMatchObject({
        code: 'CLI_EXECUTION_FAILED',
        kind: 'TIMEOUT',
      })
      expect(queue.getStats()).toEqual({ active: 0, queued: 0, maxConcurrency: 1 })
    })
  })

  describe('3. Környezet-izoláció, cliConfigDir, secret redaction és hiba-kategorizálás', () => {
    it('strips DISCORD_BOT_TOKEN and unrelated API keys, isolates provider auth keys, and applies cliConfigDir', () => {
      const fullEnv = {
        PATH: '/usr/local/bin:/usr/bin',
        HOME: '/home/alfred',
        DISCORD_BOT_TOKEN: 'Bot secret-discord-token',
        DEEPSEEK_API_KEY: 'sk-deepseek-1234567890',
        XAI_API_KEY: 'xai-secret',
        VERTEX_EU_ACCESS_TOKEN: 'ya29.vertex-secret',
        DASHBOARD_TOKEN: 'dash-secret',
        CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-claude',
        OPENAI_API_KEY: 'sk-openai-codex',
        GEMINI_API_KEY: 'AIzaSyGeminiKey123456',
      }

      const claudeEnv = buildSanitizedCliEnv('claude-cli', fullEnv, '/opt/profiles/claude-work')
      expect(claudeEnv.PATH).toBe('/usr/local/bin:/usr/bin')
      expect(claudeEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-claude')
      expect(claudeEnv.CLAUDE_CONFIG_DIR).toBe('/opt/profiles/claude-work')
      expect(claudeEnv.DISCORD_BOT_TOKEN).toBeUndefined()
      expect(claudeEnv.DEEPSEEK_API_KEY).toBeUndefined()
      expect(claudeEnv.OPENAI_API_KEY).toBeUndefined()
      expect(claudeEnv.GEMINI_API_KEY).toBeUndefined()
      expect(claudeEnv.DASHBOARD_TOKEN).toBeUndefined()

      const codexEnv = buildSanitizedCliEnv('codex-cli', fullEnv, '/opt/profiles/codex-work')
      expect(codexEnv.OPENAI_API_KEY).toBe('sk-openai-codex')
      expect(codexEnv.CODEX_HOME).toBe('/opt/profiles/codex-work')
      expect(codexEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
      expect(codexEnv.GEMINI_API_KEY).toBeUndefined()

      const geminiEnv = buildSanitizedCliEnv('gemini-cli', fullEnv, '/opt/profiles/gemini-work')
      expect(geminiEnv.GEMINI_API_KEY).toBe('AIzaSyGeminiKey123456')
      expect(geminiEnv.GEMINI_CLI_HOME).toBe('/opt/profiles/gemini-work')
      expect(geminiEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
      expect(geminiEnv.OPENAI_API_KEY).toBeUndefined()
    })

    it('redacts tokens in sanitizeCliText and classifies AUTH_REQUIRED, RATE_LIMITED, BINARY_NOT_FOUND', () => {
      const redacted = sanitizeCliText(
        'Auth fail with sk-ant-oat01-abcdef12345 sk-proj-987654321 Bearer tok.123 Bot disc.456 ya29.gcp123 AIzaSyFakeGoogleKey999',
      )
      expect(redacted).not.toContain('abcdef12345')
      expect(redacted).not.toContain('987654321')
      expect(redacted).not.toContain('tok.123')
      expect(redacted).not.toContain('disc.456')
      expect(redacted).not.toContain('gcp123')
      expect(redacted).not.toContain('FakeGoogleKey999')

      expect(classifyCliError('claude-cli', 1, 'Error: Not logged in. Please run login.', false)).toBe('AUTH_REQUIRED')
      expect(classifyCliError('codex-cli', 1, 'HTTP 429 Too Many Requests: quota exceeded', false)).toBe('RATE_LIMITED')
      expect(classifyCliError('gemini-cli', null, 'spawn gemini ENOENT', false, 'ENOENT')).toBe('BINARY_NOT_FOUND')

      const authErr = new CliExecutionError({
        provider: 'claude-cli',
        kind: 'AUTH_REQUIRED',
        exitCode: 1,
        stderr: 'Not logged in with token sk-ant-oat01-secret123456',
      })
      expect(authErr.discordMessage).toContain('sudo -u alfred claude login')
      expect(authErr.discordMessage).not.toContain('secret123456')
    })
  })

  describe('4. Hibrid protectedPaths ellenőrzés és visszaállítás (git + SHA-256 hash)', () => {
    it('reverts modified tracked protected files, restores .gitignore-d .env via SHA-256 hash, deletes untracked files in deploy/, and allows normal edits', async () => {
      const repoDir = join(tempDir, 'repo')
      mkdirSync(repoDir, { recursive: true })
      initTempGitRepo(repoDir)

      const agent = makeCliAgent({
        id: 'alfred-self-coder',
        provider: 'claude-cli',
        workspace: '.',
        workspaceAbsPath: repoDir,
        protectedPaths: ['config/agents.json', '.env', 'deploy/', 'store/'],
      })

      // A) Tracked protected file modified -> reverted via git + ProtectedPathError
      await expect(
        runCliAgent({
          agent,
          userMessage: 'tamper config',
          env: {},
          processRunner: async () => {
            writeFileSync(join(repoDir, 'config', 'agents.json'), '{"hacked":true}\n', 'utf-8')
            return { stdout: JSON.stringify({ result: 'done' }), stderr: '', exitCode: 0, signal: null, timedOut: false }
          },
        }),
      ).rejects.toBeInstanceOf(ProtectedPathError)
      expect(readFileSync(join(repoDir, 'config', 'agents.json'), 'utf-8')).toBe('{"version":1,"agents":[]}\n')

      // B) .gitignore'd .env modified -> caught by SHA-256 snapshot, restored, and ProtectedPathError thrown
      await expect(
        runCliAgent({
          agent,
          userMessage: 'tamper .env',
          env: {},
          processRunner: async () => {
            writeFileSync(join(repoDir, '.env'), 'DISCORD_BOT_TOKEN=pwned\n', 'utf-8')
            return { stdout: JSON.stringify({ result: 'done' }), stderr: '', exitCode: 0, signal: null, timedOut: false }
          },
        }),
      ).rejects.toBeInstanceOf(ProtectedPathError)
      expect(readFileSync(join(repoDir, '.env'), 'utf-8')).toBe('DISCORD_BOT_TOKEN=super-secret-token\n')

      // C) New untracked file created under protected directory deploy/ -> deleted + ProtectedPathError
      await expect(
        runCliAgent({
          agent,
          userMessage: 'inject deploy',
          env: {},
          processRunner: async () => {
            writeFileSync(join(repoDir, 'deploy', 'injected.sh'), '#!/bin/sh\nrm -rf /\n', 'utf-8')
            return { stdout: JSON.stringify({ result: 'done' }), stderr: '', exitCode: 0, signal: null, timedOut: false }
          },
        }),
      ).rejects.toBeInstanceOf(ProtectedPathError)
      expect(existsSync(join(repoDir, 'deploy', 'injected.sh'))).toBe(false)

      // D) Non-protected file modification is allowed
      const okRes = await runCliAgent({
        agent,
        userMessage: 'edit src/app.ts',
        env: {},
        processRunner: async () => {
          writeFileSync(join(repoDir, 'src', 'app.ts'), 'export const v = 2\n', 'utf-8')
          return { stdout: JSON.stringify({ result: 'updated app.ts' }), stderr: '', exitCode: 0, signal: null, timedOut: false }
        },
      })
      expect(okRes.content).toBe('updated app.ts')
      expect(readFileSync(join(repoDir, 'src', 'app.ts'), 'utf-8')).toBe('export const v = 2\n')
    })
  })

  describe('5. agents-config.ts, model-router.ts, CostOps $0 és fail-closed fallback integráció', () => {
    it('loads CLI providers, defaults model to "default" when overriding role provider, and validates cliTimeoutMs/cliConfigDir/fallback', () => {
      const cfgPath = join(tempDir, 'agents-cli.json')
      writeFileSync(
        cfgPath,
        JSON.stringify({
          version: 1,
          roles: {
            szakmunkas: { label: 'Szakmunkás', description: 'Code', provider: 'deepseek', model: 'deepseek-chat' },
          },
          agents: [
            {
              id: 'cli-claude',
              discordChannelId: '100000000000000001',
              role: 'szakmunkas',
              provider: 'claude-cli',
              tools: ['fs_read', 'fs_write'],
              cliTimeoutMs: 420000,
              cliConfigDir: '${CLI_PROFILE_BASE}/claude-a',
              fallback: { provider: 'deepseek', model: 'deepseek-chat' },
            },
            {
              id: 'cli-codex',
              discordChannelId: '100000000000000002',
              provider: 'codex-cli',
              model: 'default',
              tools: ['fs_read'],
            },
            {
              id: 'cli-gemini',
              discordChannelId: '100000000000000003',
              provider: 'gemini-cli',
              model: 'gemini-2.5-flash',
              tools: ['fs_read'],
            },
          ],
        }),
        'utf-8',
      )

      const cfg = loadAlfredAgentsConfig({
        configPath: cfgPath,
        projectRoot: tempDir,
        env: { CLI_PROFILE_BASE: '/home/alfred/profiles' },
      })

      expect(cfg.agents).toHaveLength(3)
      const c = cfg.agents[0]
      expect(c.provider).toBe('claude-cli')
      expect(c.model).toBe('default') // did NOT inherit deepseek-chat from role
      expect(c.cliTimeoutMs).toBe(420000)
      expect(c.cliConfigDir).toBe('/home/alfred/profiles/claude-a')
      expect(c.fallback).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })

      expect(cfg.agents[1].model).toBe('default')
      expect(cfg.agents[2].model).toBe('gemini-2.5-flash')

      // Invalid fallback rejected
      const badCfgPath = join(tempDir, 'bad-agents.json')
      writeFileSync(
        badCfgPath,
        JSON.stringify({
          version: 1,
          agents: [
            {
              id: 'bad-fb',
              provider: 'claude-cli',
              tools: [],
              fallback: { provider: 'deepseek', model: '' },
            },
          ],
        }),
      )
      expect(() => loadAlfredAgentsConfig({ configPath: badCfgPath, projectRoot: tempDir })).toThrow(/fallback\.model/)
    })

    it('logs CLI token usage into token_usage at $0 cost and 0 unpriced tokens in both evaluateCircuitBreaker and agentSpend', async () => {
      const db = getDb()
      const ws = join(tempDir, 'ws-cost')
      mkdirSync(ws, { recursive: true })
      const agent = makeCliAgent({
        id: 'sub-cli',
        provider: 'gemini-cli',
        model: 'default',
        workspaceAbsPath: ws,
      })

      const nowSec = 1_760_000_000
      const outcome = await runHybridAgentTurn({
        db,
        agent,
        globalDailyBudgetUsd: 10,
        userMessage: 'Szia Gemini!',
        nowSec,
        cliProcessRunner: async () => ({
          stdout: JSON.stringify({
            response: 'Helló!',
            stats: {
              models: {
                'gemini-2.5-pro': { tokens: { prompt: 1500, cached: 500, candidates: 300, thoughts: 100 } },
              },
            },
          }),
          stderr: '',
          exitCode: 0,
          signal: null,
          timedOut: false,
        }),
      })

      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      expect(outcome.replyText).toBe('Helló!')
      expect(outcome.model).toBe('gemini-cli:gemini-2.5-pro')

      const cb = evaluateCircuitBreaker({
        db,
        agentId: agent.id,
        agentDailyLimitUsd: 5,
        globalDailyLimitUsd: 10,
        nowSec,
      })
      expect(cb.allowed).toBe(true)
      expect(cb.agentSpendUsd).toBe(0)
      expect(cb.globalSpendUsd).toBe(0)

      const spend = agentSpend(db, agent.id, nowSec - 60, nowSec + 60, resolveEffectiveTokenPrices())
      expect(spend.cost).toBe(0)
      expect(spend.unpriced_tokens).toBe(0)
      expect(spend.tokens.input).toBe(1000)
      expect(spend.tokens.cache_read).toBe(500)
      expect(spend.tokens.output).toBe(400)
    })

    it('fails closed without fallback (0 API calls) and sends CLI_EXECUTION_FAILED to Discord', async () => {
      const db = getDb()
      const ws = join(tempDir, 'ws-fail-closed')
      mkdirSync(ws, { recursive: true })
      const agent = makeCliAgent({
        id: 'fail-closed-cli',
        provider: 'claude-cli',
        workspaceAbsPath: ws,
        fallback: undefined,
      })

      const fetchMock = vi.fn()
      const outcome = await runHybridAgentTurn({
        db,
        agent,
        globalDailyBudgetUsd: 10,
        userMessage: 'Teszt',
        env: { DEEPSEEK_API_KEY: 'sk-test-should-not-be-called' },
        fetchImpl: fetchMock as unknown as typeof fetch,
        cliProcessRunner: async () => ({
          stdout: '',
          stderr: '429 rate limit exceeded',
          exitCode: 1,
          signal: null,
          timedOut: false,
        }),
      })

      expect(fetchMock).not.toHaveBeenCalled()
      expect(outcome.ok).toBe(false)
      if (outcome.ok) return
      expect(outcome.code).toBe('CLI_EXECUTION_FAILED')
      if (outcome.code === 'CLI_EXECUTION_FAILED') {
        expect(outcome.errorKind).toBe('RATE_LIMITED')
        expect(outcome.discordMessage).toContain('CLI_EXECUTION_FAILED')
      }

      // Also verify Discord adapter routes CLI_EXECUTION_FAILED properly
      const sent: string[] = []
      const discordRes = await handleAlfredDiscordMessage({
        db,
        agentsConfig: {
          version: 1,
          global: {
            defaultProvider: 'claude-cli',
            defaultModel: 'default',
            dailyBudgetUsd: 10,
            budgetMultiplier: 1,
            runtimeMode: 'production',
            workspacesRoot: 'workspaces',
          },
          roles: {
            tervezo: { id: 'tervezo', label: 'T', description: 'T', provider: 'deepseek', model: 'deepseek-reasoner' },
            technikus: { id: 'technikus', label: 'T', description: 'T', provider: 'vertex-eu', model: 'gemini-3.8-flash' },
            szakmunkas: { id: 'szakmunkas', label: 'S', description: 'S', provider: 'deepseek', model: 'deepseek-chat' },
            segedmunkas: { id: 'segedmunkas', label: 'S', description: 'S', provider: 'vertex-eu', model: 'gemini-3.5-flash-lite' },
          },
          agents: [agent],
        },
        message: {
          channelId: agent.discordChannelId,
          userId: agent.allowedUserIds[0],
          messageId: 'msg-1',
          content: 'Fuss!',
        },
        env: { ALFRED_CLAUDE_BIN: 'nonexistent-claude-bin-xyz' },
        sendToDiscord: async (_ch, chunk) => {
          sent.push(chunk)
        },
      })
      expect(discordRes.status).toBe('cli_execution_failed')
      expect(sent.length).toBeGreaterThan(0)
      expect(sent[0]).toContain('CLI_EXECUTION_FAILED')
    })

    it('falls back to explicit fallback provider on CLI error, but NEVER falls back on ProtectedPathError', async () => {
      const db = getDb()
      const repoDir = join(tempDir, 'ws-fallback-repo')
      mkdirSync(repoDir, { recursive: true })
      initTempGitRepo(repoDir)

      const agentWithFallback = makeCliAgent({
        id: 'fb-agent',
        provider: 'codex-cli',
        workspace: '.',
        workspaceAbsPath: repoDir,
        protectedPaths: ['.env'],
        fallback: { provider: 'deepseek', model: 'deepseek-chat' },
      })

      const fetchMock = vi.fn(async () =>
        new Response(
          JSON.stringify({
            model: 'deepseek-chat',
            choices: [{ message: { content: 'Tartalék válasz DeepSeektől.' } }],
            usage: { prompt_tokens: 40, completion_tokens: 15 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )

      const fbOutcome = await runHybridAgentTurn({
        db,
        agent: agentWithFallback,
        globalDailyBudgetUsd: 10,
        userMessage: 'Segíts!',
        env: { DEEPSEEK_API_KEY: 'sk-valid-fallback' },
        fetchImpl: fetchMock as unknown as typeof fetch,
        cliProcessRunner: async () => ({
          stdout: '',
          stderr: 'quota exhausted',
          exitCode: 1,
          signal: null,
          timedOut: false,
        }),
      })

      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fbOutcome.ok).toBe(true)
      if (fbOutcome.ok) {
        expect(fbOutcome.provider).toBe('deepseek')
        expect(fbOutcome.replyText).toContain('Tartalék válasz DeepSeektől.')
        expect(fbOutcome.replyText).toContain('[Fallback: deepseek/deepseek-chat]')
      }

      // Security violation (ProtectedPathError) must NEVER trigger fallback API calls
      fetchMock.mockClear()
      await expect(
        runHybridAgentTurn({
          db,
          agent: agentWithFallback,
          globalDailyBudgetUsd: 10,
          userMessage: 'Modify .env!',
          env: { DEEPSEEK_API_KEY: 'sk-valid-fallback' },
          fetchImpl: fetchMock as unknown as typeof fetch,
          cliProcessRunner: async () => {
            writeFileSync(join(repoDir, '.env'), 'HACKED=1\n', 'utf-8')
            return { stdout: '{}', stderr: '', exitCode: 0, signal: null, timedOut: false }
          },
        }),
      ).rejects.toBeInstanceOf(ProtectedPathError)
      expect(fetchMock).not.toHaveBeenCalled()
      expect(readFileSync(join(repoDir, '.env'), 'utf-8')).toBe('DISCORD_BOT_TOKEN=super-secret-token\n')
    })
  })

  describe('6. checkCliProvidersHealth pre-flight diagnosztika', () => {
    it('reports installed binaries, versions, and auth readiness for claude-cli, codex-cli, and gemini-cli', async () => {
      const statuses = await checkCliProvidersHealth({
        env: {
          CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test',
          GEMINI_API_KEY: 'AIzaTestKey12345',
        },
        processRunner: async (req) => {
          if (req.command === 'claude') {
            return { stdout: '1.2.3 (Claude Code)\n', stderr: '', exitCode: 0, signal: null, timedOut: false }
          }
          if (req.command === 'codex') {
            return { stdout: '', stderr: 'not found', exitCode: null, signal: null, timedOut: false, spawnErrorCode: 'ENOENT' }
          }
          return { stdout: '0.9.0\n', stderr: '', exitCode: 0, signal: null, timedOut: false }
        },
      })

      expect(statuses).toEqual([
        {
          provider: 'claude-cli',
          binary: 'claude',
          installed: true,
          version: '1.2.3 (Claude Code)',
          authConfigured: true,
          authMethod: 'oauth',
          authDetail: 'CLAUDE_CODE_OAUTH_TOKEN (.env)',
        },
        {
          provider: 'codex-cli',
          binary: 'codex',
          installed: false,
          authConfigured: false,
          authMethod: 'none',
        },
        {
          provider: 'gemini-cli',
          binary: 'gemini',
          installed: true,
          version: '0.9.0',
          authConfigured: true,
          authMethod: 'api_key',
          authDetail: 'GEMINI_API_KEY (.env)',
        },
        {
          provider: 'agy-cli',
          binary: 'agy',
          installed: true,
          version: '0.9.0',
          authConfigured: true,
          authMethod: 'api_key',
          authDetail: 'GEMINI_API_KEY (.env)',
        },
      ])
    })
  })

  describe('7. Discord sorban állási értesítés és 2000 karakteres darabolás', () => {
    it('sends a Discord queue notice when a concurrent CLI call waits and chunks replies >2000 chars', async () => {
      const db = getDb()
      const ws = join(tempDir, 'ws-discord-queue')
      mkdirSync(ws, { recursive: true })
      const agent = makeCliAgent({
        id: 'discord-cli-agent',
        provider: 'claude-cli',
        discordChannelId: '888888888888888888',
        workspaceAbsPath: ws,
        tools: ['fs_read'],
      })
      const agentsConfig = {
        version: 1,
        global: {
          defaultProvider: 'claude-cli' as const,
          defaultModel: 'default',
          dailyBudgetUsd: 10,
          budgetMultiplier: 1,
          runtimeMode: 'production' as const,
          workspacesRoot: 'workspaces',
        },
        roles: {
          tervezo: { id: 'tervezo' as const, label: 'T', description: 'T', provider: 'deepseek' as const, model: 'deepseek-reasoner' },
          technikus: { id: 'technikus' as const, label: 'T', description: 'T', provider: 'vertex-eu' as const, model: 'gemini-3.8-flash' },
          szakmunkas: { id: 'szakmunkas' as const, label: 'S', description: 'S', provider: 'deepseek' as const, model: 'deepseek-chat' },
          segedmunkas: { id: 'segedmunkas' as const, label: 'S', description: 'S', provider: 'vertex-eu' as const, model: 'gemini-3.5-flash-lite' },
        },
        agents: [agent],
      }

      const longLine = 'A'.repeat(2400)
      const runner: CliProcessRunner = async (req) => {
        const promptArg = req.args[req.args.indexOf('-p') + 1]
        if (promptArg.includes('második')) {
          return { stdout: JSON.stringify({ result: longLine }), stderr: '', exitCode: 0, signal: null, timedOut: false }
        }
        await new Promise((r) => setTimeout(r, 40))
        return { stdout: JSON.stringify({ result: 'Első kész' }), stderr: '', exitCode: 0, signal: null, timedOut: false }
      }

      const sent1: string[] = []
      const sent2: string[] = []

      const [res1, res2] = await Promise.all([
        handleAlfredDiscordMessage({
          db,
          agentsConfig,
          message: { channelId: agent.discordChannelId, userId: agent.allowedUserIds[0], messageId: 'm1', content: 'első kérés' },
          env: {},
          cliProcessRunner: runner,
          sendToDiscord: async (_ch, chunk) => {
            sent1.push(chunk)
          },
        }),
        handleAlfredDiscordMessage({
          db,
          agentsConfig,
          message: { channelId: agent.discordChannelId, userId: agent.allowedUserIds[0], messageId: 'm2', content: 'második kérés' },
          env: {},
          cliProcessRunner: runner,
          sendToDiscord: async (_ch, chunk) => {
            sent2.push(chunk)
          },
        }),
      ])

      expect(res1.status).toBe('replied')
      expect(res2.status).toBe('replied')
      expect(sent2.some((c) => c.includes('⏳ Sorban állás (1. a sorban)'))).toBe(true)
      for (const chunk of [...sent1, ...sent2]) {
        expect(chunk.length).toBeLessThanOrEqual(2000)
      }
      expect(sent2.filter((c) => !c.includes('⏳ Sorban állás')).join('')).toBe(longLine)
    })
  })

  describe('8. cli-manager.ts, /api/admin/clis és cli_manage eszköz', () => {
    function makeMockHttpCtx(
      method: string,
      path: string,
      headers: Record<string, string> = {},
      body?: unknown,
    ): { ctx: RouteContext; getStatus: () => number; getJson: () => Record<string, unknown> } {
      const req = new EventEmitter() as http.IncomingMessage
      req.method = method
      req.url = path
      req.headers = { 'content-type': 'application/json', ...headers }
      if (body !== undefined) {
        queueMicrotask(() => {
          req.emit('data', Buffer.from(JSON.stringify(body), 'utf-8'))
          req.emit('end')
        })
      } else {
        queueMicrotask(() => req.emit('end'))
      }

      let status = 200
      let rawBody = ''
      const res = {
        writeHead(code: number) {
          status = code
          return this
        },
        end(chunk?: string | Buffer) {
          if (chunk) rawBody += chunk.toString()
          return this
        },
        setHeader() {
          return this
        },
      } as unknown as http.ServerResponse

      const url = new URL(`http://127.0.0.1:3420${path}`)
      return {
        ctx: { req, res, path: url.pathname, method, url },
        getStatus: () => status,
        getJson: () => JSON.parse(rawBody || '{}') as Record<string, unknown>,
      }
    }

    it('enforces strict CLI allowlist and rejects unknown package/command names', async () => {
      expect(normalizeManagedCliId('claude')).toBe('claude')
      expect(normalizeManagedCliId('claude-cli')).toBe('claude')
      expect(normalizeManagedCliId('codex')).toBe('codex')
      expect(normalizeManagedCliId('gemini-cli')).toBe('gemini')

      expect(() => normalizeManagedCliId('evil-pkg')).toThrow(CliManagerValidationError)
      expect(() => normalizeManagedCliId('claude; rm -rf /')).toThrow(CliManagerValidationError)
      await expect(installOrUpdateCli('@evil/malicious', { env: { HOME: tempDir } })).rejects.toBeInstanceOf(
        CliManagerValidationError,
      )
      await expect(removeCli('bash', { env: { HOME: tempDir } })).rejects.toBeInstanceOf(CliManagerValidationError)
    })

    it('runs getCliInventory(), installOrUpdateCli() into user prefix, and removeCli() with optional purgeAuth', async () => {
      const fakeHome = join(tempDir, 'alfred-home')
      const prefix = join(fakeHome, '.local')
      const authDir = join(fakeHome, '.claude')
      mkdirSync(authDir, { recursive: true })
      writeFileSync(join(authDir, '.credentials.json'), '{"ok":true}', 'utf-8')

      const calls: CliSpawnRequest[] = []
      const runner: CliProcessRunner = async (req) => {
        calls.push(req)
        if (req.command === 'npm') {
          return { stdout: '+ @anthropic-ai/claude-code@1.5.0\n', stderr: '', exitCode: 0, signal: null, timedOut: false }
        }
        if (req.command === 'claude') {
          return { stdout: '1.5.0 (Claude Code)\n', stderr: '', exitCode: 0, signal: null, timedOut: false }
        }
        return { stdout: '', stderr: 'not installed', exitCode: null, signal: null, timedOut: false, spawnErrorCode: 'ENOENT' }
      }

      const env = {
        HOME: fakeHome,
        PATH: '/usr/bin',
        DISCORD_BOT_TOKEN: 'secret-discord-should-not-leak',
      }

      const installRes = await installOrUpdateCli('claude', { env, processRunner: runner })
      expect(installRes.ok).toBe(true)
      expect(installRes.packageName).toBe('@anthropic-ai/claude-code')
      expect(installRes.prefix).toBe(prefix)
      expect(calls[0].command).toBe('npm')
      expect(calls[0].args).toEqual(['install', '-g', '@anthropic-ai/claude-code@latest'])
      expect(calls[0].env.NPM_CONFIG_PREFIX).toBe(prefix)
      expect(calls[0].env.DISCORD_BOT_TOKEN).toBeUndefined()

      const inventory = await getCliInventory({ env, processRunner: runner })
      expect(inventory).toHaveLength(4)
      const claudeItem = inventory.find((i) => i.id === 'claude')!
      expect(claudeItem.installed).toBe(true)
      expect(claudeItem.version).toBe('1.5.0 (Claude Code)')
      expect(claudeItem.authConfigured).toBe(true)

      // Remove without purgeAuth -> preserves ~/.claude
      const rmKeep = await removeCli('claude', { env, processRunner: runner })
      expect(rmKeep.purgedAuth).toBe(false)
      expect(existsSync(authDir)).toBe(true)

      // Remove with purgeAuth: true -> removes ~/.claude
      const rmPurge = await removeCli('claude', { env, purgeAuth: true, processRunner: runner })
      expect(rmPurge.purgedAuth).toBe(true)
      expect(existsSync(authDir)).toBe(false)
    })

    it('protects /api/admin/clis endpoints with DASHBOARD_TOKEN / owner gate and validates provider param', async () => {
      const prevDashToken = process.env['DASHBOARD_TOKEN']
      process.env['DASHBOARD_TOKEN'] = 'test-admin-dash-secret-123'
      try {
        // 1) Missing token -> 401
        const unauth = makeMockHttpCtx('GET', '/api/admin/clis')
        expect(await tryHandleAlfredVps(unauth.ctx)).toBe(true)
        expect(unauth.getStatus()).toBe(401)

        // 2) Wrong token -> 401
        const wrong = makeMockHttpCtx('POST', '/api/admin/clis/claude/install', {
          authorization: 'Bearer wrong-token',
        })
        expect(await tryHandleAlfredVps(wrong.ctx)).toBe(true)
        expect(wrong.getStatus()).toBe(401)

        // 3) Insufficient subagent token -> 403
        const subagent = makeMockHttpCtx('GET', '/api/admin/clis')
        subagent.ctx.auth = { kind: 'token', tokenAgent: 'other-agent' }
        expect(await tryHandleAlfredVps(subagent.ctx)).toBe(true)
        expect(subagent.getStatus()).toBe(403)

        // 4) Valid Bearer DASHBOARD_TOKEN on GET /api/admin/clis -> 200
        const validGet = makeMockHttpCtx('GET', '/api/admin/clis', {
          authorization: 'Bearer test-admin-dash-secret-123',
        })
        expect(await tryHandleAlfredVps(validGet.ctx)).toBe(true)
        expect(validGet.getStatus()).toBe(200)
        const payload = validGet.getJson()
        expect(payload['ok']).toBe(true)
        expect(Array.isArray(payload['clis'])).toBe(true)
        expect((payload['clis'] as Array<{ id: string }>).map((c) => c.id)).toEqual(['claude', 'codex', 'gemini', 'agy'])

        // 5) Invalid provider on POST /api/admin/clis/evil/install with valid token -> 400
        const badProv = makeMockHttpCtx('POST', '/api/admin/clis/evil-pkg/install', {
          'x-dashboard-token': 'test-admin-dash-secret-123',
        })
        expect(await tryHandleAlfredVps(badProv.ctx)).toBe(true)
        expect(badProv.getStatus()).toBe(400)

        // 6) GET /api/admin/overview -> 401 unauthenticated, 200 with Bearer DASHBOARD_TOKEN
        const unauthOverview = makeMockHttpCtx('GET', '/api/admin/overview')
        expect(await tryHandleAlfredVps(unauthOverview.ctx)).toBe(true)
        expect(unauthOverview.getStatus()).toBe(401)

        const authOverview = makeMockHttpCtx('GET', '/api/admin/overview', {
          authorization: 'Bearer test-admin-dash-secret-123',
        })
        expect(await tryHandleAlfredVps(authOverview.ctx)).toBe(true)
        expect(authOverview.getStatus()).toBe(200)
        const ov = authOverview.getJson()
        expect(ov['ok']).toBe(true)
        expect(ov['system']).toBeTruthy()
        expect(ov['cliQueue']).toEqual({ active: 0, queued: 0, maxConcurrency: 1 })
        expect(ov['global']).toBeTruthy()
        expect(Array.isArray(ov['agents'])).toBe(true)
        const ovAgents = ov['agents'] as Array<{ id: string; provider: string; model: string; fallback: unknown }>
        expect(ovAgents.some((a) => a.id === 'alfred-ops')).toBe(true)
      } finally {
        if (prevDashToken === undefined) delete process.env['DASHBOARD_TOKEN']
        else process.env['DASHBOARD_TOKEN'] = prevDashToken
      }
    })

    it('restricts cli_manage tool strictly to alfred-ops (in config/agents.json and executeWhitelistedToolAsync)', async () => {
      const db = getDb()
      const ws = join(tempDir, 'ws-ops-tool')
      mkdirSync(ws, { recursive: true })

      const cfg = loadAlfredAgentsConfig({ provisionWorkspaces: false })
      for (const ag of cfg.agents) {
        if (ag.id === 'alfred-ops') {
          expect(ag.tools).toContain('cli_manage')
        } else {
          expect(ag.tools).not.toContain('cli_manage')
        }
      }

      const opsAgent = makeCliAgent({
        id: 'alfred-ops',
        workspaceAbsPath: ws,
        tools: ['bash', 'fs_read', 'memory', 'cli_manage'],
      })
      const otherAgent = makeCliAgent({
        id: 'alfred-coder-hypatia',
        workspaceAbsPath: ws,
        tools: ['bash', 'fs_read', 'fs_write', 'cli_manage'],
      })

      await expect(
        executeWhitelistedToolAsync({ agent: otherAgent, db }, 'cli_manage', { action: 'status' }),
      ).rejects.toBeInstanceOf(ToolNotAllowedError)

      const out = await executeWhitelistedToolAsync(
        { agent: opsAgent, db },
        'cli_manage',
        { action: 'install', provider: 'codex' },
        {
          env: { HOME: tempDir, PATH: '/usr/bin' },
          processRunner: async (req) => {
            if (req.command === 'npm') {
              return { stdout: 'installed @openai/codex', stderr: '', exitCode: 0, signal: null, timedOut: false }
            }
            if (req.command === 'codex') {
              return { stdout: '0.2.0', stderr: '', exitCode: 0, signal: null, timedOut: false }
            }
            return { stdout: '', stderr: 'not found', exitCode: null, signal: null, timedOut: false, spawnErrorCode: 'ENOENT' }
          },
        },
      )
      const parsed = JSON.parse(out) as { ok: boolean; id: string; packageName: string }
      expect(parsed.ok).toBe(true)
      expect(parsed.id).toBe('codex')
      expect(parsed.packageName).toBe('@openai/codex')
    })

    it('distinguishes oauth vs api_key vs none, saves credentials (JSON & token), logs out cleanly, and parses OAuth login URLs/codes', async () => {
      const fakeHome = join(tempDir, 'auth-home')
      const fakeEnvFile = join(tempDir, 'auth-test.env')
      mkdirSync(fakeHome, { recursive: true })

      // 1) Gemini with only GEMINI_API_KEY -> api_key (NOT oauth)
      expect(detectCliAuthStatus('gemini-cli', { HOME: fakeHome, GEMINI_API_KEY: 'AIzaTestKey123' })).toEqual({
        method: 'api_key',
        detail: 'GEMINI_API_KEY (.env)',
      })
      // 1b) Gemini with google_accounts.json where active is null must NOT count as oauth
      mkdirSync(join(fakeHome, '.gemini'), { recursive: true })
      writeFileSync(join(fakeHome, '.gemini', 'google_accounts.json'), JSON.stringify({ active: null, old: ['a@b.com'] }), 'utf-8')
      expect(detectCliAuthStatus('gemini-cli', { HOME: fakeHome })).toEqual({ method: 'none' })
      rmSync(join(fakeHome, '.gemini', 'google_accounts.json'), { force: true })
      // 2) No auth at all -> none
      expect(detectCliAuthStatus('codex-cli', { HOME: fakeHome })).toEqual({ method: 'none' })
      expect(detectCliAuthStatus('claude-cli', { HOME: fakeHome })).toEqual({ method: 'none' })

      const noopRunner: CliProcessRunner = async () => ({
        stdout: '1.0.0\n',
        stderr: '',
        exitCode: 0,
        signal: null,
        timedOut: false,
      })

      // 3) Save OAuth JSON for gemini -> writes ~/.gemini/oauth_creds.json and switches authMethod to 'oauth'
      const savedJson = await saveCliCredentials(
        'gemini',
        { authJson: JSON.stringify({ access_token: 'ya29.test', refresh_token: '1//test' }) },
        { env: { HOME: fakeHome, GEMINI_API_KEY: 'AIzaTestKey123' }, envFilePath: fakeEnvFile, updateProcessEnv: false, processRunner: noopRunner },
      )
      expect(savedJson.ok).toBe(true)
      expect(savedJson.savedKind).toBe('oauth_json')
      expect(savedJson.target).toBe('oauth_creds.json')
      expect(existsSync(join(fakeHome, '.gemini', 'oauth_creds.json'))).toBe(true)
      expect(savedJson.status?.authMethod).toBe('oauth')
      expect(savedJson.status?.authDetail).toBe('~/.gemini/oauth_creds.json')

      // 4) Logout gemini -> removes oauth_creds.json, falls back to api_key from GEMINI_API_KEY
      const loggedOutGemini = await logoutCli('gemini', {
        env: { HOME: fakeHome, GEMINI_API_KEY: 'AIzaTestKey123' },
        envFilePath: fakeEnvFile,
        updateProcessEnv: false,
        processRunner: noopRunner,
      })
      expect(loggedOutGemini.removedFiles).toEqual(['oauth_creds.json'])
      expect(existsSync(join(fakeHome, '.gemini', 'oauth_creds.json'))).toBe(false)
      expect(loggedOutGemini.status?.authMethod).toBe('api_key')

      // 5) Save Claude OAuth setup token -> writes CLAUDE_CODE_OAUTH_TOKEN to .env and reports 'oauth'
      const savedClaudeTok = await saveCliCredentials(
        'claude',
        { token: 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF' },
        { env: { HOME: fakeHome }, envFilePath: fakeEnvFile, updateProcessEnv: false, processRunner: noopRunner },
      )
      expect(savedClaudeTok.savedKind).toBe('env_token')
      expect(savedClaudeTok.target).toBe('CLAUDE_CODE_OAUTH_TOKEN')
      expect(savedClaudeTok.status?.authMethod).toBe('oauth')
      expect(readFileSync(fakeEnvFile, 'utf-8')).toContain('CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-')

      // 6) Logout Claude -> removes CLAUDE_CODE_OAUTH_TOKEN from .env
      const loggedOutClaude = await logoutCli('claude', {
        env: { HOME: fakeHome, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF' },
        envFilePath: fakeEnvFile,
        updateProcessEnv: false,
        processRunner: noopRunner,
      })
      expect(loggedOutClaude.clearedEnvKeys).toEqual(['CLAUDE_CODE_OAUTH_TOKEN'])
      expect(readFileSync(fakeEnvFile, 'utf-8')).not.toContain('CLAUDE_CODE_OAUTH_TOKEN=')
      expect(loggedOutClaude.status?.authMethod).toBe('none')

      // 7) Invalid JSON rejected
      await expect(
        saveCliCredentials('codex', { authJson: 'not-json' }, { env: { HOME: fakeHome }, envFilePath: fakeEnvFile, updateProcessEnv: false }),
      ).rejects.toBeInstanceOf(CliManagerValidationError)

      // 8) OAuth URL & Codex device code extraction
      expect(extractCliLoginUrl('claude', 'Open https://claude.ai/oauth/authorize?client_id=123 to login')).toBe(
        'https://claude.ai/oauth/authorize?client_id=123',
      )
      expect(extractCliLoginUrl('gemini', 'Visit https://accounts.google.com/o/oauth2/v2/auth?scope=openid now')).toBe(
        'https://accounts.google.com/o/oauth2/v2/auth?scope=openid',
      )
      expect(extractCliLoginUrl('codex', 'Go to https://auth.openai.com/codex/device and enter code ABCD-1234')).toBe(
        'https://auth.openai.com/codex/device',
      )
      expect(extractCodexDeviceCode('Enter one-time code: ABCD-1234')).toBe('ABCD-1234')
      // Untrusted host must be rejected
      expect(extractCliLoginUrl('claude', 'Open https://evil.example.com/oauth/authorize?x=1')).toBeNull()

      // 9) Submitted localhost callback URL parsing (Claude code#state + local relay)
      const parsedCb = parseSubmittedLoginInput(
        'claude',
        'localhost:44471/callback?code=QfBOcAk1&state=IN8tWgwb',
      )
      expect(parsedCb).toEqual({
        localCallbackUrl: 'http://127.0.0.1:44471/callback?code=QfBOcAk1&state=IN8tWgwb',
        ptyCode: 'QfBOcAk1#IN8tWgwb',
      })
      expect(parseSubmittedLoginInput('claude', 'raw-code#state123')).toEqual({
        ptyCode: 'raw-code#state123',
      })
      // Non-localhost URL must NOT produce a localCallbackUrl (no SSRF)
      expect(parseSubmittedLoginInput('claude', 'https://evil.example.com/callback?code=1')).toEqual({
        ptyCode: 'https://evil.example.com/callback?code=1',
      })
    })

    it('protects /api/admin/clis/:provider/auth, /logout, and /login/status with DASHBOARD_TOKEN gate', async () => {
      const prevDashToken = process.env['DASHBOARD_TOKEN']
      process.env['DASHBOARD_TOKEN'] = 'test-admin-auth-secret-999'
      try {
        // Unauthenticated -> 401
        const unauthAuth = makeMockHttpCtx('POST', '/api/admin/clis/gemini/auth', {}, { token: 'x' })
        expect(await tryHandleAlfredVps(unauthAuth.ctx)).toBe(true)
        expect(unauthAuth.getStatus()).toBe(401)

        const unauthStatus = makeMockHttpCtx('GET', '/api/admin/clis/gemini/login/status')
        expect(await tryHandleAlfredVps(unauthStatus.ctx)).toBe(true)
        expect(unauthStatus.getStatus()).toBe(401)

        // Authenticated GET /login/status -> 200
        const okStatus = makeMockHttpCtx('GET', '/api/admin/clis/gemini/login/status', {
          authorization: 'Bearer test-admin-auth-secret-999',
        })
        expect(await tryHandleAlfredVps(okStatus.ctx)).toBe(true)
        expect(okStatus.getStatus()).toBe(200)
        expect(okStatus.getJson()['ok']).toBe(true)

        // Authenticated POST /auth with invalid JSON -> 400
        const badJson = makeMockHttpCtx(
          'POST',
          '/api/admin/clis/gemini/auth',
          { authorization: 'Bearer test-admin-auth-secret-999' },
          { authJson: '{bad' },
        )
        expect(await tryHandleAlfredVps(badJson.ctx)).toBe(true)
        expect(badJson.getStatus()).toBe(400)
      } finally {
        if (prevDashToken === undefined) delete process.env['DASHBOARD_TOKEN']
        else process.env['DASHBOARD_TOKEN'] = prevDashToken
      }
    })
  })
})
