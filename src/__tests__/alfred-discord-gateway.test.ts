import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import {
  AlfredDiscordGateway,
  clearVertexTokenCache,
  DEFAULT_ALFRED_INTENTS,
  GatewayOpcode,
  loadAlfredAgentsConfig,
  type GatewayWebSocketLike,
  type HandleDiscordMessageResult,
} from '../alfred/index.js'

class FakeGatewayWebSocket implements GatewayWebSocketLike {
  readyState = 0 // CONNECTING -> becomes 1 (OPEN)
  readonly url: string
  readonly sentFrames: string[] = []
  readonly closeCalls: Array<{ code?: number; reason?: string }> = []
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>()

  constructor(url: string) {
    this.url = url
  }

  send(data: string): void {
    this.sentFrames.push(data)
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason })
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

  emitServerClose(code: number, reason: string = ''): void {
    this.readyState = 3
    this.emit('close', { code, reason })
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

const BASE_ENV = {
  DISCORD_BOT_TOKEN: 'discord-test-bot-token',
  ALLOWED_USER_IDS: '777777777777777777',
  DISCORD_CHANNEL_ALFRED_HQ: '1111111111111111111',
  DISCORD_CHANNEL_PROJ_HYPATIA: '2222222222222222222',
  DISCORD_CHANNEL_ALFRED_QA: '3333333333333333333',
  VERTEX_EU_PROJECT_ID: 'eu-gdpr-proj',
  VERTEX_EU_LOCATION: 'eu',
  VERTEX_EU_ACCESS_TOKEN: 'ya29.test-token',
  ALFRED_GLOBAL_DAILY_BUDGET_USD: '15.0',
}

describe('Alfred Discord Gateway v10 Client', () => {
  const activeGateways: AlfredDiscordGateway[] = []

  beforeEach(() => {
    clearVertexTokenCache()
    initDatabase(':memory:')
  })

  afterEach(() => {
    while (activeGateways.length > 0) {
      activeGateways.pop()!.stop()
    }
  })

  it('performs HELLO -> IDENTIFY, sends jittered + periodic heartbeats, handles op 1 & ACK, and resolves on READY', async () => {
    const cfg = loadAlfredAgentsConfig({ env: BASE_ENV, provisionWorkspaces: false })
    const sockets: FakeGatewayWebSocket[] = []

    const mockFetch = vi.fn(async (url: string | URL) => {
      if (String(url) === 'https://discord.com/api/v10/gateway/bot') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ url: 'wss://gateway.discord.test' }),
        } as Response
      }
      throw new Error(`Unexpected fetch: ${String(url)}`)
    })

    const gateway = new AlfredDiscordGateway({
      db: getDb(),
      agentsConfig: cfg,
      env: BASE_ENV,
      fetchImpl: mockFetch as unknown as typeof fetch,
      webSocketFactory: (url) => {
        const ws = new FakeGatewayWebSocket(url)
        sockets.push(ws)
        return ws
      },
      heartbeatJitterFn: () => 0.1,
    })
    activeGateways.push(gateway)

    const startPromise = gateway.start()
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    const ws = sockets[0]
    expect(ws.url).toBe('wss://gateway.discord.test/?v=10&encoding=json')

    ws.emitOpen()
    ws.emitServerPayload({ op: GatewayOpcode.HELLO, d: { heartbeat_interval: 100 } })

    const identify = ws.parsedSent().find((f) => f.op === GatewayOpcode.IDENTIFY)
    expect(identify).toBeDefined()
    expect((identify!.d as { intents: number }).intents).toBe(DEFAULT_ALFRED_INTENTS)

    ws.emitServerPayload({
      op: GatewayOpcode.DISPATCH,
      t: 'READY',
      s: 1,
      d: {
        user: { id: '1573455126864068759', username: 'Alfred' },
        session_id: 'sess-ready-1',
        resume_gateway_url: 'wss://resume.discord.test',
      },
    })

    const ready = await startPromise
    expect(ready).toEqual({
      botUserId: '1573455126864068759',
      botUsername: 'Alfred',
      sessionId: 'sess-ready-1',
      resumeGatewayUrl: 'wss://resume.discord.test',
    })

    // Wait for initial jittered heartbeat + ACK + server op 1 ping
    await vi.waitFor(() => {
      expect(ws.parsedSent().some((f) => f.op === GatewayOpcode.HEARTBEAT)).toBe(true)
    })
    ws.emitServerPayload({ op: GatewayOpcode.HEARTBEAT_ACK })

    // Server-initiated heartbeat request (op 1) must elicit an immediate heartbeat
    const beforePingCount = ws.parsedSent().filter((f) => f.op === GatewayOpcode.HEARTBEAT).length
    ws.emitServerPayload({ op: GatewayOpcode.HEARTBEAT, d: null })
    const afterPingFrames = ws.parsedSent().filter((f) => f.op === GatewayOpcode.HEARTBEAT)
    expect(afterPingFrames.length).toBeGreaterThan(beforePingCount)
    expect(afterPingFrames.at(-1)?.d).toBe(1)

    // Ack next beat so zombie watchdog doesn't close prematurely before clean stop
    ws.emitServerPayload({ op: GatewayOpcode.HEARTBEAT_ACK })
  })

  it('routes allowed messages, filters bots/self, blocks unauthorized users, caches thread parent_id, and serializes per channel', async () => {
    const cfg = loadAlfredAgentsConfig({ env: BASE_ENV, provisionWorkspaces: false })
    const sockets: FakeGatewayWebSocket[] = []
    const handledEvents: Array<{ result: HandleDiscordMessageResult; msgId: string }> = []
    const sentDiscord: Array<{ channelId: string; text: string }> = []
    const callOrder: string[] = []
    let releaseFirstLlm!: () => void
    const firstLlmGate = new Promise<void>((resolve) => {
      releaseFirstLlm = resolve
    })
    let llmCallIndex = 0
    let typingCalls = 0
    let threadLookupCalls = 0

    const mockFetch = vi.fn(async (url: string | URL) => {
      const u = String(url)
      if (u === 'https://discord.com/api/v10/gateway/bot') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ url: 'wss://gateway.discord.test' }),
        } as Response
      }
      if (u.endsWith('/typing')) {
        typingCalls += 1
        return { ok: true, status: 204, text: async () => '' } as Response
      }
      if (u === 'https://discord.com/api/v10/channels/999000111222') {
        threadLookupCalls += 1
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: '999000111222', parent_id: '3333333333333333333' }),
        } as Response
      }
      if (u.includes('aiplatform.eu.rep.googleapis.com')) {
        llmCallIndex += 1
        const idx = llmCallIndex
        callOrder.push(`llm-start-${idx}`)
        if (idx === 1) {
          await firstLlmGate
        }
        callOrder.push(`llm-end-${idx}`)
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [{ content: { parts: [{ text: `QA Gateway OK #${idx}` }] } }],
            usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10 },
          }),
        } as Response
      }
      throw new Error(`Unexpected fetch: ${u}`)
    })

    const gateway = new AlfredDiscordGateway({
      db: getDb(),
      agentsConfig: cfg,
      env: BASE_ENV,
      fetchImpl: mockFetch as unknown as typeof fetch,
      webSocketFactory: (url) => {
        const ws = new FakeGatewayWebSocket(url)
        sockets.push(ws)
        return ws
      },
      sendToDiscord: async (channelId, text) => {
        sentDiscord.push({ channelId, text })
      },
      onMessageHandled: (result, rawMessageId) => {
        handledEvents.push({ result, msgId: rawMessageId })
      },
      heartbeatJitterFn: () => 0.9,
    })
    activeGateways.push(gateway)

    const startPromise = gateway.start()
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    const ws = sockets[0]
    ws.emitOpen()
    ws.emitServerPayload({ op: GatewayOpcode.HELLO, d: { heartbeat_interval: 60_000 } })
    ws.emitServerPayload({
      op: GatewayOpcode.DISPATCH,
      t: 'READY',
      s: 1,
      d: {
        user: { id: '1573455126864068759', username: 'Alfred' },
        session_id: 'sess-route',
        resume_gateway_url: 'wss://resume.discord.test',
      },
    })
    await startPromise

    // 1. Bot and self messages must be completely ignored
    ws.emitServerPayload({
      op: GatewayOpcode.DISPATCH,
      t: 'MESSAGE_CREATE',
      s: 2,
      d: {
        id: 'm-bot',
        channel_id: '3333333333333333333',
        content: 'ignore bot',
        author: { id: '888', username: 'SomeBot', bot: true },
      },
    })
    ws.emitServerPayload({
      op: GatewayOpcode.DISPATCH,
      t: 'MESSAGE_CREATE',
      s: 3,
      d: {
        id: 'm-self',
        channel_id: '3333333333333333333',
        content: 'ignore self',
        author: { id: '1573455126864068759', username: 'Alfred', bot: false },
      },
    })

    // 2. Unauthorized user: denied without calling LLM or sending typing indicator
    ws.emitServerPayload({
      op: GatewayOpcode.DISPATCH,
      t: 'MESSAGE_CREATE',
      s: 4,
      d: {
        id: 'm-unauth',
        channel_id: '3333333333333333333',
        content: 'unauthorized message',
        author: { id: '999999999999999999', username: 'Intruder' },
      },
    })

    await vi.waitFor(() => expect(handledEvents).toHaveLength(1))
    expect(handledEvents[0].result.status).toBe('denied_unauthorized_user')
    expect(typingCalls).toBe(0)
    expect(llmCallIndex).toBe(0)
    expect(sentDiscord).toHaveLength(0)

    // 3. Two rapid thread messages: must resolve parent_id once (cached!) and serialize strictly
    ws.emitServerPayload({
      op: GatewayOpcode.DISPATCH,
      t: 'MESSAGE_CREATE',
      s: 5,
      d: {
        id: 'm-thread-1',
        channel_id: '999000111222',
        content: 'Első thread kérdés',
        author: { id: '777777777777777777', username: 'Owner' },
      },
    })
    ws.emitServerPayload({
      op: GatewayOpcode.DISPATCH,
      t: 'MESSAGE_CREATE',
      s: 6,
      d: {
        id: 'm-thread-2',
        channel_id: '999000111222',
        content: 'Második thread kérdés',
        author: { id: '777777777777777777', username: 'Owner' },
      },
    })

    // First message starts LLM call #1 and waits on firstLlmGate; second MUST NOT start yet
    await vi.waitFor(() => expect(callOrder).toEqual(['llm-start-1']))
    releaseFirstLlm()

    await vi.waitFor(() => expect(handledEvents).toHaveLength(3))

    expect(callOrder).toEqual(['llm-start-1', 'llm-end-1', 'llm-start-2', 'llm-end-2'])
    expect(threadLookupCalls).toBe(1) // Cached across second message in same thread
    expect(typingCalls).toBeGreaterThanOrEqual(2)
    expect(sentDiscord).toEqual([
      { channelId: '999000111222', text: 'QA Gateway OK #1' },
      { channelId: '999000111222', text: 'QA Gateway OK #2' },
    ])
  })

  it('reconnects on op 7 RECONNECT using resume_gateway_url and sends op 6 RESUME', async () => {
    const cfg = loadAlfredAgentsConfig({ env: BASE_ENV, provisionWorkspaces: false })
    const sockets: FakeGatewayWebSocket[] = []

    const mockFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ url: 'wss://gateway.discord.test' }),
    }))

    const gateway = new AlfredDiscordGateway({
      db: getDb(),
      agentsConfig: cfg,
      env: BASE_ENV,
      fetchImpl: mockFetch as unknown as typeof fetch,
      webSocketFactory: (url) => {
        const ws = new FakeGatewayWebSocket(url)
        sockets.push(ws)
        return ws
      },
      reconnectBaseDelayMs: 15,
      heartbeatJitterFn: () => 0.9,
    })
    activeGateways.push(gateway)

    const startPromise = gateway.start()
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    const ws1 = sockets[0]
    ws1.emitOpen()
    ws1.emitServerPayload({ op: GatewayOpcode.HELLO, d: { heartbeat_interval: 60_000 } })
    ws1.emitServerPayload({
      op: GatewayOpcode.DISPATCH,
      t: 'READY',
      s: 42,
      d: {
        user: { id: '1573455126864068759', username: 'Alfred' },
        session_id: 'sess-resume-xyz',
        resume_gateway_url: 'wss://resume.discord.test',
      },
    })
    await startPromise

    // Server sends RECONNECT (op 7)
    ws1.emitServerPayload({ op: GatewayOpcode.RECONNECT, d: null })
    expect(ws1.closeCalls[0]?.code).toBe(4000)

    await vi.waitFor(() => expect(sockets).toHaveLength(2))
    const ws2 = sockets[1]
    expect(ws2.url).toBe('wss://resume.discord.test/?v=10&encoding=json')

    ws2.emitOpen()
    ws2.emitServerPayload({ op: GatewayOpcode.HELLO, d: { heartbeat_interval: 60_000 } })

    const resumeFrame = ws2.parsedSent().find((f) => f.op === GatewayOpcode.RESUME)
    expect(resumeFrame).toEqual({
      op: GatewayOpcode.RESUME,
      d: {
        token: 'discord-test-bot-token',
        session_id: 'sess-resume-xyz',
        seq: 42,
      },
    })

    ws2.emitServerPayload({
      op: GatewayOpcode.DISPATCH,
      t: 'RESUMED',
      s: 43,
      d: {},
    })
  })

  it('fails fast without reconnecting on fatal close code 4014 (Disallowed intent)', async () => {
    const cfg = loadAlfredAgentsConfig({ env: BASE_ENV, provisionWorkspaces: false })
    const sockets: FakeGatewayWebSocket[] = []
    const fatalErrors: Error[] = []

    const mockFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ url: 'wss://gateway.discord.test' }),
    }))

    const gateway = new AlfredDiscordGateway({
      db: getDb(),
      agentsConfig: cfg,
      env: BASE_ENV,
      fetchImpl: mockFetch as unknown as typeof fetch,
      webSocketFactory: (url) => {
        const ws = new FakeGatewayWebSocket(url)
        sockets.push(ws)
        return ws
      },
      reconnectBaseDelayMs: 10,
      heartbeatJitterFn: () => 0.9,
      onFatalError: (err) => {
        fatalErrors.push(err)
      },
    })
    activeGateways.push(gateway)

    const startPromise = gateway.start()
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    const ws = sockets[0]
    ws.emitOpen()
    ws.emitServerPayload({ op: GatewayOpcode.HELLO, d: { heartbeat_interval: 60_000 } })
    ws.emitServerClose(4014, 'Disallowed intent(s)')

    await expect(startPromise).rejects.toThrow(/4014.*Message Content Intent/i)
    expect(fatalErrors).toHaveLength(1)
    expect(fatalErrors[0].message).toContain('Message Content Intent')

    // Ensure no reconnect is scheduled even after reconnectBaseDelayMs passes
    await new Promise((r) => setTimeout(r, 50))
    expect(sockets).toHaveLength(1)
  })
})
