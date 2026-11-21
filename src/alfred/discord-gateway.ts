import type Database from 'better-sqlite3'
import { readEnvFile } from '../env.js'
import { logger } from '../logger.js'
import {
  getAgentByChannelId,
  isUserAllowedForAgent,
  resolveGlobalAllowedUserIds,
  type AlfredAgentsConfig,
} from './agents-config.js'
import {
  createAlfredDiscordSender,
  handleAlfredDiscordMessage,
  type DiscordSendFn,
  type HandleDiscordMessageResult,
} from './discord-adapter.js'
import {
  prefixTestReply,
  resolveAlfredRuntimeEnv,
  type AlfredRuntimeEnv,
} from './runtime-env.js'

export const DISCORD_API_BASE = 'https://discord.com/api/v10'
export const DISCORD_GATEWAY_VERSION = 10

export const GatewayOpcode = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const

export const GatewayIntents = {
  GUILDS: 1 << 0,
  GUILD_MESSAGES: 1 << 9,
  DIRECT_MESSAGES: 1 << 12,
  MESSAGE_CONTENT: 1 << 15,
} as const

/** GUILDS (1) | GUILD_MESSAGES (512) | MESSAGE_CONTENT (32768) = 33281 */
export const DEFAULT_ALFRED_INTENTS =
  GatewayIntents.GUILDS | GatewayIntents.GUILD_MESSAGES | GatewayIntents.MESSAGE_CONTENT

/** Fatal Discord Gateway close codes that MUST NOT trigger blind reconnect loops. */
export const FATAL_GATEWAY_CLOSE_CODES = new Set<number>([
  4004, // Authentication failed
  4010, // Invalid shard
  4011, // Sharding required
  4012, // Invalid API version
  4013, // Invalid intent(s)
  4014, // Disallowed intent(s) — usually Message Content Intent not enabled
])

export interface GatewayWebSocketLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: string, listener: (event: unknown) => void): void
}

export type GatewayWebSocketFactory = (url: string) => GatewayWebSocketLike

export interface DiscordGatewayReadyInfo {
  botUserId: string
  botUsername: string
  sessionId: string
  resumeGatewayUrl: string
}

export interface AlfredDiscordGatewayOptions {
  db: Database.Database
  agentsConfig: AlfredAgentsConfig
  token?: string
  intents?: number
  env?: Record<string, string | undefined>
  runtimeEnv?: AlfredRuntimeEnv
  fetchImpl?: typeof fetch
  webSocketFactory?: GatewayWebSocketFactory
  sendToDiscord?: DiscordSendFn
  enableTypingIndicator?: boolean
  reconnectBaseDelayMs?: number
  heartbeatJitterFn?: () => number
  onReady?: (info: DiscordGatewayReadyInfo) => void
  onMessageHandled?: (result: HandleDiscordMessageResult, rawMessageId: string) => void
  onFatalError?: (err: Error) => void
}

interface GatewayPayload {
  op: number
  d?: unknown
  s?: number | null
  t?: string | null
}

interface DiscordMessageCreatePayload {
  id: string
  channel_id: string
  content?: string
  timestamp?: string
  webhook_id?: string
  author?: {
    id: string
    username?: string
    global_name?: string | null
    bot?: boolean
  }
}

function sanitizeGatewayText(value: string): string {
  return value
    .replace(/Bot\s+[A-Za-z0-9._-]+/g, 'Bot [REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [REDACTED]')
    .replace(/ya29\.[A-Za-z0-9._-]+/g, '[REDACTED_TOKEN]')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-[REDACTED]')
}

function appendGatewayQuery(baseUrl: string): string {
  const clean = baseUrl.trim()
  if (clean.includes('?v=')) return clean
  const stripped = clean.replace(/\/+$/, '')
  return `${stripped}/?v=${DISCORD_GATEWAY_VERSION}&encoding=json`
}

function defaultWebSocketFactory(url: string): GatewayWebSocketLike {
  const Ctor = (
    globalThis as unknown as {
      WebSocket?: new (socketUrl: string) => GatewayWebSocketLike
    }
  ).WebSocket
  if (typeof Ctor !== 'function') {
    throw new Error('Native WebSocket is not available in this Node.js runtime (requires Node >= 22)')
  }
  return new Ctor(url)
}

function decodeWsMessageData(data: unknown): string | null {
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString('utf-8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf-8')
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf-8')
  }
  return null
}

function describeFatalCloseCode(code: number, reason: string): Error {
  const cleanReason = reason ? ` (${reason})` : ''
  if (code === 4014) {
    return new Error(
      `Discord Gateway closed with code 4014${cleanReason}: Disallowed intent(s). Enable "Message Content Intent" in Discord Developer Portal -> Application -> Bot -> Privileged Gateway Intents -> Message Content Intent.`,
    )
  }
  if (code === 4004) {
    return new Error(
      `Discord Gateway closed with code 4004${cleanReason}: Authentication failed. Check DISCORD_BOT_TOKEN in .env.`,
    )
  }
  return new Error(`Discord Gateway closed with fatal code ${code}${cleanReason}`)
}

/**
 * Queries Discord REST API `/gateway/bot` to resolve the WSS gateway URL.
 */
export async function fetchDiscordGatewayUrl(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const cleanToken = token.trim()
  if (!cleanToken) {
    throw new Error('DISCORD_BOT_TOKEN is missing or empty')
  }

  const resp = await fetchImpl(`${DISCORD_API_BASE}/gateway/bot`, {
    method: 'GET',
    headers: {
      Authorization: `Bot ${cleanToken}`,
    },
  })

  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(
      `Discord /gateway/bot API error ${resp.status}: ${sanitizeGatewayText(body.slice(0, 200))}`,
    )
  }

  const data = (await resp.json()) as { url?: string }
  if (typeof data.url !== 'string' || !data.url.trim()) {
    throw new Error('Discord /gateway/bot returned no gateway url')
  }

  return appendGatewayQuery(data.url)
}

/**
 * Best-effort typing indicator ping (`POST /channels/{channelId}/typing`).
 * Never throws so typing failures cannot block message processing.
 */
export async function sendDiscordTypingIndicator(
  token: string,
  channelId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  try {
    const resp = await fetchImpl(
      `${DISCORD_API_BASE}/channels/${encodeURIComponent(channelId)}/typing`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bot ${token}`,
        },
      },
    )
    if (!resp.ok) {
      logger.debug({ channelId, status: resp.status }, 'Discord typing indicator returned non-OK')
    }
  } catch (err) {
    logger.debug({ channelId, err }, 'Discord typing indicator failed')
  }
}

/**
 * Lightweight, zero-dependency Discord Gateway v10 WebSocket client for Alfred.
 * Handles IDENTIFY, heartbeats with jitter/ACK watchdog, RESUME/reconnect,
 * thread parent resolution, per-channel serialization, and typing indicators.
 */
export class AlfredDiscordGateway {
  private readonly db: Database.Database
  private readonly agentsConfig: AlfredAgentsConfig
  private readonly envMap: Record<string, string | undefined>
  private readonly runtimeEnv: AlfredRuntimeEnv
  private readonly token: string
  private readonly intents: number
  private readonly fetchImpl: typeof fetch
  private readonly webSocketFactory: GatewayWebSocketFactory
  private readonly sendToDiscord?: DiscordSendFn
  private readonly enableTypingIndicator: boolean
  private readonly reconnectBaseDelayMs: number
  private readonly heartbeatJitterFn: () => number
  private readonly onReady?: (info: DiscordGatewayReadyInfo) => void
  private readonly onMessageHandled?: (result: HandleDiscordMessageResult, rawMessageId: string) => void
  private readonly onFatalError?: (err: Error) => void

  private socket: GatewayWebSocketLike | null = null
  private initialGatewayUrl: string | null = null
  private resumeGatewayUrl: string | null = null
  private sessionId: string | null = null
  private botUserId: string | null = null
  private botUsername: string | null = null
  private lastSeq: number | null = null
  private awaitingHeartbeatAck = false
  private reconnectAttempts = 0
  private stopped = false

  private heartbeatJitterTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatIntervalTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private readonly activeTypingTimers = new Set<ReturnType<typeof setInterval>>()
  private readonly channelQueues = new Map<string, Promise<void>>()
  private readonly parentChannelCache = new Map<string, string | null>()

  private readyResolved = false
  private resolveInitialReady: ((info: DiscordGatewayReadyInfo) => void) | null = null
  private rejectInitialReady: ((err: Error) => void) | null = null

  constructor(opts: AlfredDiscordGatewayOptions) {
    this.db = opts.db
    this.agentsConfig = opts.agentsConfig
    this.envMap = opts.env ?? { ...readEnvFile(), ...process.env }
    this.runtimeEnv = opts.runtimeEnv ?? resolveAlfredRuntimeEnv(this.envMap)
    this.token = (opts.token ?? this.envMap['DISCORD_BOT_TOKEN'] ?? process.env['DISCORD_BOT_TOKEN'] ?? '').trim()

    const envIntentsRaw = this.envMap['DISCORD_GATEWAY_INTENTS']
    if (typeof opts.intents === 'number' && Number.isInteger(opts.intents) && opts.intents >= 0) {
      this.intents = opts.intents
    } else if (
      envIntentsRaw !== undefined &&
      envIntentsRaw.trim() !== '' &&
      Number.isInteger(Number(envIntentsRaw)) &&
      Number(envIntentsRaw) >= 0
    ) {
      this.intents = Number(envIntentsRaw)
    } else {
      this.intents = DEFAULT_ALFRED_INTENTS
    }

    this.fetchImpl = opts.fetchImpl ?? fetch
    this.webSocketFactory = opts.webSocketFactory ?? defaultWebSocketFactory
    this.sendToDiscord = opts.sendToDiscord
    this.enableTypingIndicator = opts.enableTypingIndicator ?? true
    this.reconnectBaseDelayMs = Math.max(1, opts.reconnectBaseDelayMs ?? 1000)
    this.heartbeatJitterFn = opts.heartbeatJitterFn ?? Math.random
    this.onReady = opts.onReady
    this.onMessageHandled = opts.onMessageHandled
    this.onFatalError = opts.onFatalError
  }

  /**
   * Resolves the gateway URL via Discord REST API and opens the WebSocket connection.
   * Resolves once `READY` is received; rejects immediately on fatal close codes before `READY`.
   */
  async start(): Promise<DiscordGatewayReadyInfo> {
    if (!this.token) {
      throw new Error('DISCORD_BOT_TOKEN is missing or empty')
    }

    this.stopped = false
    this.readyResolved = false
    this.initialGatewayUrl = await fetchDiscordGatewayUrl(this.token, this.fetchImpl)

    return new Promise<DiscordGatewayReadyInfo>((resolve, reject) => {
      this.resolveInitialReady = resolve
      this.rejectInitialReady = reject
      this.connect(this.initialGatewayUrl!)
    })
  }

  /**
   * Gracefully shuts down heartbeats, reconnects, typing indicators, and the active socket.
   */
  stop(): void {
    this.stopped = true
    this.clearHeartbeatTimers()

    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    for (const t of this.activeTypingTimers) {
      clearInterval(t)
    }
    this.activeTypingTimers.clear()

    if (!this.readyResolved && this.rejectInitialReady) {
      const reject = this.rejectInitialReady
      this.resolveInitialReady = null
      this.rejectInitialReady = null
      reject(new Error('Discord Gateway stopped before READY'))
    }

    if (this.socket) {
      try {
        if (this.socket.readyState <= 1) {
          this.socket.close(1000, 'Alfred shutting down')
        }
      } catch {
        // ignore close errors during shutdown
      }
      this.socket = null
    }
  }

  private connect(gatewayUrl: string): void {
    if (this.stopped) return

    const ws = this.webSocketFactory(gatewayUrl)
    this.socket = ws

    ws.addEventListener('open', () => {
      logger.debug({ gatewayUrl }, 'Discord Gateway WebSocket connected')
    })

    ws.addEventListener('message', (rawEvent: unknown) => {
      if (this.socket !== ws || this.stopped) return
      const ev = rawEvent as { data?: unknown }
      const rawText = decodeWsMessageData(ev?.data)
      if (!rawText) return
      let payload: GatewayPayload
      try {
        payload = JSON.parse(rawText) as GatewayPayload
      } catch (err) {
        logger.warn({ err }, 'Discord Gateway received invalid JSON frame')
        return
      }
      this.handleGatewayPayload(ws, payload)
    })

    ws.addEventListener('error', (rawEvent: unknown) => {
      if (this.socket !== ws || this.stopped) return
      const ev = rawEvent as { message?: string; error?: unknown }
      logger.warn(
        { message: sanitizeGatewayText(String(ev?.message ?? ev?.error ?? 'WebSocket error')) },
        'Discord Gateway socket error',
      )
    })

    ws.addEventListener('close', (rawEvent: unknown) => {
      if (this.socket !== ws) return
      this.clearHeartbeatTimers()
      this.socket = null

      if (this.stopped) return

      const ev = rawEvent as { code?: number; reason?: string }
      const code = typeof ev?.code === 'number' ? ev.code : 1006
      const reason = typeof ev?.reason === 'string' ? sanitizeGatewayText(ev.reason) : ''

      if (FATAL_GATEWAY_CLOSE_CODES.has(code)) {
        this.stopped = true
        const fatalErr = describeFatalCloseCode(code, reason)
        logger.error({ code, reason }, fatalErr.message)
        this.onFatalError?.(fatalErr)
        if (!this.readyResolved && this.rejectInitialReady) {
          const reject = this.rejectInitialReady
          this.resolveInitialReady = null
          this.rejectInitialReady = null
          reject(fatalErr)
        }
        return
      }

      logger.warn({ code, reason }, 'Discord Gateway disconnected; scheduling reconnect')
      this.scheduleReconnect()
    })
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return

    const delayMs = Math.min(30_000, this.reconnectBaseDelayMs * 2 ** this.reconnectAttempts)
    this.reconnectAttempts += 1

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.stopped) return

      const targetUrl =
        this.sessionId && this.resumeGatewayUrl && this.lastSeq !== null
          ? appendGatewayQuery(this.resumeGatewayUrl)
          : this.initialGatewayUrl

      if (targetUrl) {
        this.connect(targetUrl)
        return
      }

      fetchDiscordGatewayUrl(this.token, this.fetchImpl)
        .then((freshUrl) => {
          this.initialGatewayUrl = freshUrl
          this.connect(freshUrl)
        })
        .catch((err) => {
          logger.warn({ err }, 'Discord Gateway URL re-fetch failed; retrying')
          this.scheduleReconnect()
        })
    }, delayMs)
  }

  private handleGatewayPayload(ws: GatewayWebSocketLike, payload: GatewayPayload): void {
    if (typeof payload.s === 'number') {
      this.lastSeq = payload.s
    }

    switch (payload.op) {
      case GatewayOpcode.HELLO: {
        const d = payload.d as { heartbeat_interval?: number } | undefined
        const intervalMs =
          typeof d?.heartbeat_interval === 'number' && d.heartbeat_interval > 0
            ? d.heartbeat_interval
            : 41_250
        this.startHeartbeatLoop(ws, intervalMs)

        if (this.sessionId && this.resumeGatewayUrl && this.lastSeq !== null) {
          this.sendJson(ws, {
            op: GatewayOpcode.RESUME,
            d: {
              token: this.token,
              session_id: this.sessionId,
              seq: this.lastSeq,
            },
          })
        } else {
          this.sendJson(ws, {
            op: GatewayOpcode.IDENTIFY,
            d: {
              token: this.token,
              intents: this.intents,
              properties: {
                os: process.platform,
                browser: 'alfred',
                device: 'alfred',
              },
              presence: this.runtimeEnv.discordPresence,
            },
          })
        }
        break
      }

      case GatewayOpcode.HEARTBEAT: {
        this.sendHeartbeat(ws)
        break
      }

      case GatewayOpcode.HEARTBEAT_ACK: {
        this.awaitingHeartbeatAck = false
        break
      }

      case GatewayOpcode.RECONNECT: {
        logger.info('Discord Gateway requested RECONNECT (op 7); reconnecting with RESUME state')
        ws.close(4000, 'Requested reconnect')
        break
      }

      case GatewayOpcode.INVALID_SESSION: {
        const resumable = payload.d === true
        if (!resumable) {
          this.sessionId = null
          this.resumeGatewayUrl = null
          this.lastSeq = null
        }
        logger.warn({ resumable }, 'Discord Gateway INVALID_SESSION (op 9); reconnecting')
        ws.close(4000, 'Invalid session')
        break
      }

      case GatewayOpcode.DISPATCH: {
        this.handleDispatchEvent(payload.t ?? '', payload.d)
        break
      }

      default:
        break
    }
  }

  private startHeartbeatLoop(ws: GatewayWebSocketLike, intervalMs: number): void {
    this.clearHeartbeatTimers()
    this.awaitingHeartbeatAck = false

    const jitter = Math.min(1, Math.max(0, this.heartbeatJitterFn()))
    const initialDelayMs = Math.max(10, Math.floor(intervalMs * jitter))

    this.heartbeatJitterTimer = setTimeout(() => {
      this.heartbeatJitterTimer = null
      if (this.socket !== ws || this.stopped) return
      this.sendHeartbeat(ws)

      this.heartbeatIntervalTimer = setInterval(() => {
        if (this.socket !== ws || this.stopped) return
        if (this.awaitingHeartbeatAck) {
          logger.warn('Discord Gateway heartbeat ACK timeout; closing socket to reconnect')
          ws.close(4000, 'Heartbeat ACK timeout')
          return
        }
        this.sendHeartbeat(ws)
      }, intervalMs)
    }, initialDelayMs)
  }

  private sendHeartbeat(ws: GatewayWebSocketLike): void {
    this.awaitingHeartbeatAck = true
    this.sendJson(ws, {
      op: GatewayOpcode.HEARTBEAT,
      d: this.lastSeq,
    })
  }

  private sendJson(ws: GatewayWebSocketLike, data: unknown): void {
    try {
      if (ws.readyState <= 1) {
        ws.send(JSON.stringify(data))
      }
    } catch (err) {
      logger.debug({ err }, 'Discord Gateway failed to send payload')
    }
  }

  private clearHeartbeatTimers(): void {
    if (this.heartbeatJitterTimer !== null) {
      clearTimeout(this.heartbeatJitterTimer)
      this.heartbeatJitterTimer = null
    }
    if (this.heartbeatIntervalTimer !== null) {
      clearInterval(this.heartbeatIntervalTimer)
      this.heartbeatIntervalTimer = null
    }
    this.awaitingHeartbeatAck = false
  }

  private handleDispatchEvent(eventType: string, rawData: unknown): void {
    if (eventType === 'READY') {
      const d = rawData as {
        user?: { id?: string; username?: string }
        session_id?: string
        resume_gateway_url?: string
      }
      this.botUserId = d.user?.id ?? ''
      this.botUsername = d.user?.username ?? 'Alfred'
      this.sessionId = d.session_id ?? null
      this.resumeGatewayUrl = d.resume_gateway_url ?? this.initialGatewayUrl
      this.reconnectAttempts = 0

      const readyInfo: DiscordGatewayReadyInfo = {
        botUserId: this.botUserId,
        botUsername: this.botUsername,
        sessionId: this.sessionId ?? '',
        resumeGatewayUrl: this.resumeGatewayUrl ?? '',
      }

      logger.info(
        {
          alfredEnv: this.runtimeEnv.mode,
          botUserId: readyInfo.botUserId,
          botUsername: readyInfo.botUsername,
        },
        'Discord Gateway READY',
      )
      this.onReady?.(readyInfo)

      if (!this.readyResolved && this.resolveInitialReady) {
        this.readyResolved = true
        const resolve = this.resolveInitialReady
        this.resolveInitialReady = null
        this.rejectInitialReady = null
        resolve(readyInfo)
      }
      return
    }

    if (eventType === 'RESUMED') {
      this.reconnectAttempts = 0
      logger.info({ alfredEnv: this.runtimeEnv.mode, lastSeq: this.lastSeq }, 'Discord Gateway RESUMED')
      return
    }

    if (eventType === 'MESSAGE_CREATE') {
      this.handleInboundGatewayMessage(rawData as DiscordMessageCreatePayload)
    }
  }

  private handleInboundGatewayMessage(d: DiscordMessageCreatePayload): void {
    if (!d || typeof d.id !== 'string' || typeof d.channel_id !== 'string' || !d.author) {
      return
    }
    if (d.author.bot === true || d.author.id === this.botUserId || Boolean(d.webhook_id)) {
      return
    }

    const channelId = d.channel_id
    const prevQueue = this.channelQueues.get(channelId) ?? Promise.resolve()

    const nextQueue = prevQueue
      .catch(() => { })
      .then(() => this.processChannelMessage(d))
      .finally(() => {
        if (this.channelQueues.get(channelId) === nextQueue) {
          this.channelQueues.delete(channelId)
        }
      })

    this.channelQueues.set(channelId, nextQueue)
  }

  private async resolveParentChannelId(channelId: string): Promise<string | null> {
    if (this.parentChannelCache.has(channelId)) {
      return this.parentChannelCache.get(channelId) ?? null
    }

    try {
      const resp = await this.fetchImpl(
        `${DISCORD_API_BASE}/channels/${encodeURIComponent(channelId)}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bot ${this.token}`,
          },
        },
      )
      if (!resp.ok) {
        this.parentChannelCache.set(channelId, null)
        return null
      }
      const data = (await resp.json()) as { parent_id?: string | null }
      const parentId =
        typeof data.parent_id === 'string' && data.parent_id.trim() ? data.parent_id.trim() : null
      this.parentChannelCache.set(channelId, parentId)
      return parentId
    } catch {
      this.parentChannelCache.set(channelId, null)
      return null
    }
  }

  private async processChannelMessage(d: DiscordMessageCreatePayload): Promise<void> {
    if (this.stopped || !d.author) return

    let agent = getAgentByChannelId(this.agentsConfig, d.channel_id)
    let parentChannelId: string | undefined

    if (!agent) {
      const resolvedParent = await this.resolveParentChannelId(d.channel_id)
      if (resolvedParent) {
        parentChannelId = resolvedParent
        agent = getAgentByChannelId(this.agentsConfig, resolvedParent)
      }
    }

    if (!agent) {
      return
    }

    const content = typeof d.content === 'string' ? d.content : ''
    if (!content.trim()) {
      logger.warn(
        { channelId: d.channel_id, messageId: d.id, authorId: d.author.id },
        'Discord MESSAGE_CREATE received with empty content (verify Message Content Intent or non-text message)',
      )
      return
    }

    const globalAllowed = resolveGlobalAllowedUserIds(this.envMap)
    const userAllowed = isUserAllowedForAgent(d.author.id, agent, globalAllowed)

    let typingTimer: ReturnType<typeof setInterval> | null = null
    if (userAllowed && this.enableTypingIndicator) {
      void sendDiscordTypingIndicator(this.token, d.channel_id, this.fetchImpl)
      typingTimer = setInterval(() => {
        if (!this.stopped) {
          void sendDiscordTypingIndicator(this.token, d.channel_id, this.fetchImpl)
        }
      }, 8000)
      this.activeTypingTimers.add(typingTimer)
    }

    try {
      const result = await handleAlfredDiscordMessage({
        db: this.db,
        agentsConfig: this.agentsConfig,
        message: {
          channelId: d.channel_id,
          parentChannelId,
          userId: d.author.id,
          username: d.author.global_name ?? d.author.username,
          messageId: d.id,
          content,
          timestampIso: d.timestamp,
        },
        env: this.envMap,
        sendToDiscord: this.sendToDiscord,
        fetchImpl: this.fetchImpl,
      })

      this.onMessageHandled?.(result, d.id)
    } catch (err) {
      const msg = sanitizeGatewayText(err instanceof Error ? err.message : String(err))
      logger.error({ channelId: d.channel_id, messageId: d.id, error: msg }, 'Alfred Discord message handling failed')
      const sender = this.sendToDiscord ?? createAlfredDiscordSender(this.envMap)
      const errText = prefixTestReply(
        `⚠️ Hiba történt a kérés feldolgozása közben: ${msg.slice(0, 300)}`,
        this.runtimeEnv,
      )
      await sender(d.channel_id, errText).catch(() => { })
    } finally {
      if (typingTimer !== null) {
        clearInterval(typingTimer)
        this.activeTypingTimers.delete(typingTimer)
      }
    }
  }
}
