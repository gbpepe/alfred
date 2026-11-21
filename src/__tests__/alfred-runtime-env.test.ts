import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import {
  AlfredDiscordGateway,
  buildDiscordPresence,
  clearVertexTokenCache,
  DEFAULT_TEST_REPLY_PREFIX,
  GatewayOpcode,
  handleAlfredDiscordMessage,
  loadAlfredAgentsConfig,
  parseAlfredEnvMode,
  prefixTestReply,
  recordModelTokenUsage,
  resolveAlfredDbPath,
  resolveAlfredRuntimeEnv,
  resolveBudgetMultiplier,
  type GatewayWebSocketLike,
} from '../alfred/index.js'

class FakeGatewayWebSocket implements GatewayWebSocketLike {
  readyState = 0
  readonly url: string
  readonly sentFrames: string[] = []
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>()

  constructor(url: string) {
    this.url = url
  }

  send(data: string): void {
    this.sentFrames.push(data)
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3
    this.emit('close', { code: code ?? 1000, reason: reason ?? '' })
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const existing = this.listeners.get(type) ?? []
    existing.push(listener)
    this.listeners.set(type, existing)
  }

  emitOpen(): void {
    this.readyState = 1
    this.emit('open', {})
  }

  emitServerPayload(payload: unknown): void {
    this.emit('message', { data: JSON.stringify(payload) })
  }

  parsedSent(): Array<{ op: number; d?: unknown }> {
    return this.sentFrames.map((raw) => JSON.parse(raw) as { op: number; d?: unknown })
  }

  private emit(type: string, event: unknown): void {
    for (const cb of this.listeners.get(type) ?? []) {
      cb(event)
    }
  }
}

describe('Alfred Runtime Env Isolation (production | test | ops)', () => {
  let tempDir: string
  const activeGateways: AlfredDiscordGateway[] = []

  beforeEach(() => {
    clearVertexTokenCache()
    tempDir = mkdtempSync(join(tmpdir(), 'alfred-runtime-env-'))
    initDatabase(':memory:')
  })

  afterEach(() => {
    while (activeGateways.length > 0) {
      activeGateways.pop()!.stop()
    }
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore Windows cleanup lock
    }
  })

  it('parses ALFRED_ENV modes, DB paths, budget multipliers, and test prefixes deterministically', () => {
    expect(parseAlfredEnvMode(undefined)).toBe('production')
    expect(parseAlfredEnvMode('production')).toBe('production')
    expect(parseAlfredEnvMode('linux-server')).toBe('production') // legacy platform.ts compatibility
    expect(parseAlfredEnvMode('test')).toBe('test')
    expect(parseAlfredEnvMode('staging')).toBe('test')
    expect(parseAlfredEnvMode('ops')).toBe('ops')

    expect(resolveBudgetMultiplier(undefined)).toBe(1.0)
    expect(resolveBudgetMultiplier('0.2')).toBe(0.2)
    expect(() => resolveBudgetMultiplier('0')).toThrow(/ALFRED_BUDGET_MULTIPLIER/)
    expect(() => resolveBudgetMultiplier('-0.5')).toThrow(/ALFRED_BUDGET_MULTIPLIER/)
    expect(() => resolveBudgetMultiplier('not-a-number')).toThrow(/ALFRED_BUDGET_MULTIPLIER/)
    expect(() => resolveBudgetMultiplier('25')).toThrow(/ALFRED_BUDGET_MULTIPLIER/)

    expect(resolveAlfredDbPath(undefined, tempDir)).toBe(join(tempDir, 'store', 'alfred.db'))
    expect(resolveAlfredDbPath('store/alfred-test.db', tempDir)).toBe(resolve(tempDir, 'store/alfred-test.db'))
    expect(resolveAlfredDbPath(':memory:', tempDir)).toBe(':memory:')

    const testRuntime = resolveAlfredRuntimeEnv(
      {
        ALFRED_ENV: 'test',
        ALFRED_DB_PATH: 'store/alfred-test.db',
        ALFRED_WORKSPACES_DIR: 'workspaces-test',
        ALFRED_BUDGET_MULTIPLIER: '0.2',
      },
      tempDir,
    )
    expect(testRuntime.mode).toBe('test')
    expect(testRuntime.isTest).toBe(true)
    expect(testRuntime.testReplyPrefix).toBe(DEFAULT_TEST_REPLY_PREFIX)
    expect(testRuntime.discordPresence.status).toBe('idle')
    expect(prefixTestReply('Válasz', testRuntime)).toBe(`${DEFAULT_TEST_REPLY_PREFIX}Válasz`)
    // Idempotent: never doubles prefix
    expect(prefixTestReply(`${DEFAULT_TEST_REPLY_PREFIX}Válasz`, testRuntime)).toBe(
      `${DEFAULT_TEST_REPLY_PREFIX}Válasz`,
    )

    const prodRuntime = resolveAlfredRuntimeEnv({ ALFRED_ENV: 'production' }, tempDir)
    expect(prodRuntime.discordPresence.status).toBe('online')
    expect(prefixTestReply('Válasz', prodRuntime)).toBe('Válasz')
  })

  it('re-bases workspaces under ALFRED_WORKSPACES_DIR, scales budgets via ALFRED_BUDGET_MULTIPLIER, and respects explicit global override', () => {
    const cfg = loadAlfredAgentsConfig({
      env: {
        ALFRED_ENV: 'test',
        ALFRED_WORKSPACES_DIR: join(tempDir, 'workspaces-test'),
        ALFRED_BUDGET_MULTIPLIER: '0.2',
        DISCORD_CHANNEL_ALFRED_HQ: '1111111111111111111',
        DISCORD_CHANNEL_PROJ_HYPATIA: '2222222222222222222',
        DISCORD_CHANNEL_ALFRED_QA: '3333333333333333333',
        DISCORD_CHANNEL_ALFRED_SELF_DEV: '4444444444444444444',
        DISCORD_CHANNEL_ALFRED_OPS: '5555555555555555555',
      },
      provisionWorkspaces: true,
    })

    expect(cfg.global.runtimeMode).toBe('test')
    expect(cfg.global.budgetMultiplier).toBe(0.2)
    expect(cfg.global.dailyBudgetUsd).toBe(3.0) // 15.0 * 0.2

    const hypatia = cfg.agents.find((a) => a.id === 'alfred-coder-hypatia')!
    const selfCoder = cfg.agents.find((a) => a.id === 'alfred-self-coder')!
    expect(hypatia.workspaceAbsPath).toBe(join(tempDir, 'workspaces-test', 'hypatia'))
    expect(existsSync(hypatia.workspaceAbsPath)).toBe(true)
    expect(hypatia.dailyBudgetUsd).toBe(1.6) // 8.0 * 0.2
    expect(selfCoder.workspaceAbsPath).toBe(resolve(process.cwd())) // "." stays project root
    expect(selfCoder.dailyBudgetUsd).toBe(1.0) // 5.0 * 0.2

    // Explicit ALFRED_GLOBAL_DAILY_BUDGET_USD stays the final global cap
    const cfgExplicitGlobal = loadAlfredAgentsConfig({
      env: {
        ALFRED_ENV: 'test',
        ALFRED_BUDGET_MULTIPLIER: '0.2',
        ALFRED_GLOBAL_DAILY_BUDGET_USD: '4.5',
      },
      provisionWorkspaces: false,
    })
    expect(cfgExplicitGlobal.global.dailyBudgetUsd).toBe(4.5)
    expect(cfgExplicitGlobal.agents.find((a) => a.id === 'alfred-architect')!.dailyBudgetUsd).toBe(1.0)
  })

  it('filters agents via ALFRED_ENABLED_AGENTS and fails closed on unknown agent IDs', () => {
    const wsDir = join(tempDir, 'ops-ws')
    const cfgOps = loadAlfredAgentsConfig({
      env: {
        ALFRED_ENV: 'ops',
        ALFRED_ENABLED_AGENTS: 'alfred-ops',
        ALFRED_WORKSPACES_DIR: wsDir,
        DISCORD_CHANNEL_ALFRED_OPS: '5555555555555555555',
      },
      provisionWorkspaces: true,
    })

    expect(cfgOps.global.runtimeMode).toBe('ops')
    expect(cfgOps.agents).toHaveLength(1)
    expect(cfgOps.agents[0].id).toBe('alfred-ops')
    // Non-enabled agent workspaces must NOT be provisioned
    expect(existsSync(join(wsDir, 'hypatia'))).toBe(false)

    expect(() =>
      loadAlfredAgentsConfig({
        env: { ALFRED_ENABLED_AGENTS: 'alfred-ops,non-existent-agent' },
        provisionWorkspaces: false,
      }),
    ).toThrow(/ALFRED_ENABLED_AGENTS.*non-existent-agent/i)
  })

  it('sends mode-specific presence in Discord Gateway IDENTIFY payload', async () => {
    const cfg = loadAlfredAgentsConfig({
      env: { ALFRED_ENV: 'test', ALFRED_ENABLED_AGENTS: 'alfred-qa', DISCORD_CHANNEL_ALFRED_QA: '3333333333333333333' },
      provisionWorkspaces: false,
    })
    const sockets: FakeGatewayWebSocket[] = []

    const mockFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ url: 'wss://gateway.discord.test' }),
    }))

    const gateway = new AlfredDiscordGateway({
      db: getDb(),
      agentsConfig: cfg,
      token: 'discord-test-token',
      env: { ALFRED_ENV: 'test' },
      fetchImpl: mockFetch as unknown as typeof fetch,
      webSocketFactory: (url) => {
        const ws = new FakeGatewayWebSocket(url)
        sockets.push(ws)
        return ws
      },
      heartbeatJitterFn: () => 0.9,
    })
    activeGateways.push(gateway)

    const startPromise = gateway.start()
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    const ws = sockets[0]
    ws.emitOpen()
    ws.emitServerPayload({ op: GatewayOpcode.HELLO, d: { heartbeat_interval: 60_000 } })

    const identify = ws.parsedSent().find((f) => f.op === GatewayOpcode.IDENTIFY)
    expect((identify!.d as { presence: unknown }).presence).toEqual(buildDiscordPresence('test'))

    ws.emitServerPayload({
      op: GatewayOpcode.DISPATCH,
      t: 'READY',
      s: 1,
      d: { user: { id: '1573455126864068759', username: 'AlfredTest' }, session_id: 's1', resume_gateway_url: 'wss://r' },
    })
    await startPromise
  })

  it('prefixes outbound Discord replies and BUDGET_EXCEEDED alerts in test mode without polluting conversation_log', async () => {
    const db = getDb()
    const env = {
      ALFRED_ENV: 'test',
      ALLOWED_USER_IDS: '100000000000000001',
      DISCORD_CHANNEL_ALFRED_HQ: '1111111111111111111',
      DEEPSEEK_API_KEY: 'sk-test',
    }
    const cfg = loadAlfredAgentsConfig({
      env: { ...env, ALFRED_ENABLED_AGENTS: 'alfred-architect' },
      provisionWorkspaces: false,
    })

    const sent: string[] = []
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        model: 'deepseek-reasoner',
        choices: [{ message: { content: 'Staging teszt válasz.' } }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }),
    })

    const okRes = await handleAlfredDiscordMessage({
      db,
      agentsConfig: cfg,
      env,
      nowSec: 1763676000,
      fetchImpl: mockFetch as unknown as typeof fetch,
      sendToDiscord: async (_ch, text) => {
        sent.push(text)
      },
      message: {
        channelId: '1111111111111111111',
        userId: '100000000000000001',
        messageId: 'm-test-1',
        content: 'Teszt kérdés',
      },
    })

    expect(okRes.status).toBe('replied')
    expect(sent[0]).toBe(`${DEFAULT_TEST_REPLY_PREFIX}Staging teszt válasz.`)

    // Verify conversation_log stored clean text without the [TEST] prefix
    const row = db
      .prepare(`SELECT text FROM conversation_log WHERE agent_id = ? AND direction = 'out'`)
      .get('alfred-architect') as { text: string }
    expect(row.text).toBe('Staging teszt válasz.')

    // Verify BUDGET_EXCEEDED alert also receives the [TEST] prefix
    recordModelTokenUsage({
      db,
      agentId: 'alfred-architect',
      sessionId: 's-over',
      model: 'deepseek-reasoner',
      provider: 'deepseek',
      inputTokens: 0,
      outputTokens: 3_000_000,
      timestampSec: 1763676000,
    })

    const sentOver: string[] = []
    const blockedRes = await handleAlfredDiscordMessage({
      db,
      agentsConfig: cfg,
      env,
      nowSec: 1763676000,
      sendToDiscord: async (_ch, text) => {
        sentOver.push(text)
      },
      message: {
        channelId: '1111111111111111111',
        userId: '100000000000000001',
        messageId: 'm-test-2',
        content: 'Második kérdés',
      },
    })

    expect(blockedRes.status).toBe('blocked_budget_exceeded')
    expect(sentOver[0].startsWith(DEFAULT_TEST_REPLY_PREFIX)).toBe(true)
    expect(sentOver[0]).toContain('BUDGET_EXCEEDED')
  })

  it('opens an isolated on-disk SQLite DB via resolveAlfredDbPath without touching live store/', () => {
    const isolatedDbPath = resolveAlfredDbPath('store/alfred-test.db', tempDir)
    expect(isolatedDbPath).toBe(join(tempDir, 'store', 'alfred-test.db'))

    mkdirSync(join(tempDir, 'store'), { recursive: true })
    initDatabase(isolatedDbPath)
    expect(existsSync(isolatedDbPath)).toBe(true)

    // Re-init back to :memory: so afterEach can remove tempDir cleanly on Windows
    initDatabase(':memory:')
  })
})
