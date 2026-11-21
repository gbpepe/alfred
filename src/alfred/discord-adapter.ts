import type Database from 'better-sqlite3'
import { getProvider } from '../channel-provider.js'
import { readEnvFile } from '../env.js'
import { logger } from '../logger.js'
import {
  getAgentByChannelId,
  isUserAllowedForAgent,
  resolveGlobalAllowedUserIds,
  type AlfredAgentDefinition,
  type AlfredAgentsConfig,
} from './agents-config.js'
import { runHybridAgentTurn, type ChatMessage, type HybridRouterOutcome } from './model-router.js'
import { prefixTestReply, resolveAlfredRuntimeEnv } from './runtime-env.js'

export const DISCORD_MAX_CHARS = 2000

/**
 * Splits a potentially long Markdown response into chunks of at most `maxLength` characters
 * (default 2000 for Discord), preserving fenced Markdown code blocks (` ```lang ... ``` `)
 * across chunk boundaries so code formatting is never broken in Discord.
 */
export function splitDiscordMessagePreservingCodeBlocks(
  text: string,
  maxLength: number = DISCORD_MAX_CHARS,
): string[] {
  if (!text) return ['']
  if (text.length <= maxLength) return [text]

  const lines = text.split('\n')
  const chunks: string[] = []
  let current = ''
  let openFenceHeader: string | null = null // e.g. "```typescript" or "```"

  const closeReserve = 5 // "\n```"

  const flushCurrent = () => {
    if (!current) return
    if (openFenceHeader !== null) {
      chunks.push(`${current}\n\`\`\``)
    } else {
      chunks.push(current)
    }
    current = openFenceHeader !== null ? openFenceHeader : ''
  }

  for (const line of lines) {
    const effectiveMax = openFenceHeader !== null ? maxLength - closeReserve : maxLength

    // Handle a single line that is itself longer than maxLength
    if (line.length > effectiveMax - (current ? current.length + 1 : 0)) {
      if (current && current !== openFenceHeader) {
        flushCurrent()
      }

      let remainingLine = line
      while (remainingLine.length > 0) {
        const prefixLen = current ? current.length + 1 : 0
        const avail = (openFenceHeader !== null ? maxLength - closeReserve : maxLength) - prefixLen
        if (remainingLine.length <= avail) {
          current = current ? `${current}\n${remainingLine}` : remainingLine
          break
        }
        const slice = remainingLine.slice(0, Math.max(1, avail))
        current = current ? `${current}\n${slice}` : slice
        remainingLine = remainingLine.slice(slice.length)
        flushCurrent()
      }
    } else {
      const candidate = current ? `${current}\n${line}` : line
      if (candidate.length > effectiveMax) {
        flushCurrent()
        current = current ? `${current}\n${line}` : line
      } else {
        current = candidate
      }
    }

    // Track fenced code block state after appending the line
    const trimmed = line.trimStart()
    if (trimmed.startsWith('```')) {
      if (openFenceHeader === null) {
        const langMatch = trimmed.match(/^```([a-zA-Z0-9_+-]*)/)
        openFenceHeader = langMatch ? `\`\`\`${langMatch[1]}` : '```'
      } else {
        openFenceHeader = null
      }
    }
  }

  if (current) {
    if (openFenceHeader !== null && !current.trimEnd().endsWith('```')) {
      chunks.push(`${current}\n\`\`\``)
    } else {
      chunks.push(current)
    }
  }

  return chunks
}

export interface InboundDiscordMessage {
  channelId: string
  /** If the message was sent inside a Discord thread, parentChannelId holds the parent channel snowflake */
  parentChannelId?: string
  userId: string
  username?: string
  messageId: string
  content: string
  timestampIso?: string
}

export interface DiscordSendFn {
  (channelId: string, chunkText: string): Promise<void>
}

export interface HandleDiscordMessageOptions {
  db: Database.Database
  agentsConfig: AlfredAgentsConfig
  message: InboundDiscordMessage
  env?: Record<string, string | undefined>
  /** Custom sender hook (defaults to Alfred's `getProvider('discord').sendMessage`) */
  sendToDiscord?: DiscordSendFn
  fetchImpl?: typeof fetch
  nowSec?: number
}

export type HandleDiscordMessageResult =
  | { status: 'ignored_unmapped_channel'; channelId: string }
  | { status: 'denied_unauthorized_user'; agentId: string; userId: string }
  | {
    status: 'blocked_budget_exceeded'
    agentId: string
    channelId: string
    sentChunks: string[]
    outcome: Extract<HybridRouterOutcome, { ok: false }>
  }
  | {
    status: 'replied'
    agentId: string
    channelId: string
    sentChunks: string[]
    outcome: Extract<HybridRouterOutcome, { ok: true }>
  }

/**
 * Loads recent conversation turns for `(agent.memoryNamespace, channelId)` from SQLite `conversation_log`
 * so each agent has its own isolated conversation history per channel.
 */
export function loadAgentConversationHistory(
  db: Database.Database,
  memoryNamespace: string,
  channelId: string,
  limit: number = 16,
): ChatMessage[] {
  const rows = db.prepare(`
    SELECT direction, text
    FROM conversation_log
    WHERE agent_id = ? AND chat_id = ? AND text IS NOT NULL AND text != ''
    ORDER BY id DESC
    LIMIT ?
  `).all(memoryNamespace, channelId, limit) as Array<{ direction: 'in' | 'out'; text: string }>

  return rows.reverse().map((r) => ({
    role: r.direction === 'in' ? 'user' : 'assistant',
    content: r.text,
  }))
}

/**
 * Persists an inbound or outbound turn in SQLite `conversation_log` under `agent.memoryNamespace`.
 */
export function recordConversationTurn(params: {
  db: Database.Database
  memoryNamespace: string
  channelId: string
  direction: 'in' | 'out'
  messageId: string | null
  text: string
  userId?: string
  username?: string
  nowSec?: number
}): void {
  const nowSec = params.nowSec ?? Math.floor(Date.now() / 1000)
  const tsIso = new Date(nowSec * 1000).toISOString()
  params.db.prepare(`
    INSERT OR IGNORE INTO conversation_log (
      agent_id, chat_id, direction, message_id, text, ts, created_at, source, sender_id, sender_name
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 'discord', ?, ?)
  `).run(
    params.memoryNamespace,
    params.channelId,
    params.direction,
    params.messageId,
    params.text,
    tsIso,
    nowSec,
    params.userId ?? null,
    params.username ?? null,
  )
}

/**
 * Default Discord sender wired directly to Alfred's `getProvider('discord')` in `src/channel-provider.ts`.
 */
export function createAlfredDiscordSender(env?: Record<string, string | undefined>): DiscordSendFn {
  const discordProvider = getProvider('discord')
  return async (channelId: string, chunkText: string) => {
    const e = env ?? { ...readEnvFile(), ...process.env }
    const token = (e['DISCORD_BOT_TOKEN'] ?? process.env['DISCORD_BOT_TOKEN'] ?? '').trim()
    if (!token) {
      throw new Error('DISCORD_BOT_TOKEN is not configured')
    }
    const formatted = discordProvider.formatMessage(chunkText)
    await discordProvider.sendMessage(token, channelId, formatted)
  }
}

/**
 * Main multi-user, channel-based Discord message handler for Alfred:
 * 1. Maps `channelId` (or `parentChannelId` for threads) -> Agent via `config/agents.json`.
 * 2. Verifies `userId` against `ALLOWED_USER_IDS` (globally and per-agent).
 * 3. Loads conversation history isolated to `agent.memoryNamespace`.
 * 4. Calls `runHybridAgentTurn` (which enforces the CostOps Circuit Breaker and Tool Whitelist).
 * 5. Splits outbound replies (or `BUDGET_EXCEEDED` notices) at 2000 chars preserving code blocks,
 *    and sends them back to the Discord channel via the Alfred Discord provider.
 */
export async function handleAlfredDiscordMessage(
  opts: HandleDiscordMessageOptions,
): Promise<HandleDiscordMessageResult> {
  const envMap = opts.env ?? { ...readEnvFile(), ...process.env }
  const lookupChannelId = opts.message.parentChannelId ?? opts.message.channelId
  const replyChannelId = opts.message.channelId

  const agent: AlfredAgentDefinition | null =
    getAgentByChannelId(opts.agentsConfig, lookupChannelId) ??
    getAgentByChannelId(opts.agentsConfig, replyChannelId)

  if (!agent) {
    return { status: 'ignored_unmapped_channel', channelId: replyChannelId }
  }

  const globalAllowed = resolveGlobalAllowedUserIds(envMap)
  if (!isUserAllowedForAgent(opts.message.userId, agent, globalAllowed)) {
    logger.warn(
      { agentId: agent.id, userId: opts.message.userId, channelId: replyChannelId },
      'Unauthorized Discord user blocked by ALLOWED_USER_IDS gate',
    )
    return {
      status: 'denied_unauthorized_user',
      agentId: agent.id,
      userId: opts.message.userId,
    }
  }

  const history = loadAgentConversationHistory(opts.db, agent.memoryNamespace, replyChannelId)

  recordConversationTurn({
    db: opts.db,
    memoryNamespace: agent.memoryNamespace,
    channelId: replyChannelId,
    direction: 'in',
    messageId: opts.message.messageId,
    text: opts.message.content,
    userId: opts.message.userId,
    username: opts.message.username,
    nowSec: opts.nowSec,
  })

  const sendFn = opts.sendToDiscord ?? createAlfredDiscordSender(envMap)
  const runtimeEnv = resolveAlfredRuntimeEnv(envMap)

  const outcome = await runHybridAgentTurn({
    db: opts.db,
    agent,
    globalDailyBudgetUsd: opts.agentsConfig.global.dailyBudgetUsd,
    userMessage: opts.message.content,
    conversationHistory: history,
    chatId: replyChannelId,
    env: envMap,
    fetchImpl: opts.fetchImpl,
    nowSec: opts.nowSec,
  })

  if (!outcome.ok) {
    const outboundBudgetMsg = prefixTestReply(outcome.discordMessage, runtimeEnv)
    const chunks = splitDiscordMessagePreservingCodeBlocks(outboundBudgetMsg, DISCORD_MAX_CHARS)
    for (const chunk of chunks) {
      await sendFn(replyChannelId, chunk)
    }
    return {
      status: 'blocked_budget_exceeded',
      agentId: agent.id,
      channelId: replyChannelId,
      sentChunks: chunks,
      outcome,
    }
  }

  recordConversationTurn({
    db: opts.db,
    memoryNamespace: agent.memoryNamespace,
    channelId: replyChannelId,
    direction: 'out',
    messageId: null,
    text: outcome.replyText,
    nowSec: opts.nowSec,
  })

  const outboundReply = prefixTestReply(outcome.replyText, runtimeEnv)
  const chunks = splitDiscordMessagePreservingCodeBlocks(outboundReply, DISCORD_MAX_CHARS)
  for (const chunk of chunks) {
    await sendFn(replyChannelId, chunk)
  }

  return {
    status: 'replied',
    agentId: agent.id,
    channelId: replyChannelId,
    sentChunks: chunks,
    outcome,
  }
}
