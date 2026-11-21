import { CHANNEL_PROVIDER, CHANNEL_TOKEN, CHANNEL_CHAT_ID, ALERT_CHAT_ID } from './config.js'
import { normalizeChatId, resolveAlertDeliveryChat } from './owner-chat.js'
import { getProvider } from './channel-provider.js'
import { logger } from './logger.js'
import { markIfTestRun } from './test-run-marker.js'

/** What a channel send did, for callers that must react to a miss. */
export interface ChannelSendResult {
  sent: boolean
  /** Why nothing (or not everything) went out. Absent when `sent` is true. */
  reason?: 'no-token' | 'no-owner-chat' | 'send-failed' | 'partial'
}

/**
 * Owner-facing send that REPORTS whether it went out, for callers that
 * cannot treat a miss as a delivery -- an approval request nobody sees is not
 * a gate.
 */
export async function sendOwnerMessage(text: string): Promise<ChannelSendResult> {
  const owner = resolveAlertDeliveryChat(undefined, CHANNEL_CHAT_ID, CHANNEL_PROVIDER)
  if (!CHANNEL_TOKEN || !owner.chatId) {
    const reason = !CHANNEL_TOKEN ? 'nincs token' : `nincs tulajdonos-chat (${owner.reason})`
    logger.warn(`Channel ertesites kihagyva: ${reason}`)
    if (CHANNEL_TOKEN) signalOwnerChatMissing(text, owner.reason ?? 'ismeretlen ok')
    return { sent: false, reason: !CHANNEL_TOKEN ? 'no-token' : 'no-owner-chat' }
  }
  return sendToChat(owner.chatId, text, 'owner')
}

export interface AlertMeta {
  /** The agent the alert is about, when there is one. */
  agent?: string | null
  /** Which case raised it, e.g. 'permission-prompt'. */
  kind: string
}

type AlertRecipient = 'owner' | 'alert-chat'
type AlertOutcome = 'sent' | 'partial' | 'failed' | 'skipped'

// True when operational alerts go to a chat other than the owner's. Callers
// must then leave owner/partner conversation content out of the alert text.
export function alertIsRedirected(): boolean {
  return normalizeChatId(ALERT_CHAT_ID) !== null
}

// Operational alert (watchdogs, restarts, stuck sessions). Goes to
// ALERT_CHAT_ID when it is set, otherwise to the owner chat.
export async function notifyChannel(text: string, meta?: AlertMeta): Promise<boolean> {
  const alertChat = normalizeChatId(ALERT_CHAT_ID)
  if (alertChat) return (await sendToChat(alertChat, text, 'alert', { meta, recipient: 'alert-chat' })).sent
  return discordOwner(text, meta)
}

type OwnerChatMissingSink = (text: string) => void
let ownerChatMissingSink: OwnerChatMissingSink | null = null
let lastOwnerChatMissingSignalAt = 0
const OWNER_CHAT_MISSING_SIGNAL_MS = 60 * 60 * 1000

export function setOwnerChatMissingSink(sink: OwnerChatMissingSink | null): void {
  ownerChatMissingSink = sink
  lastOwnerChatMissingSignalAt = 0
}

function signalOwnerChatMissing(text: string, reason: string): void {
  const now = Date.now()
  if (!ownerChatMissingSink || now - lastOwnerChatMissingSignalAt < OWNER_CHAT_MISSING_SIGNAL_MS) return
  lastOwnerChatMissingSignalAt = now
  const preview = text.length > 200 ? `${text.slice(0, 200)} [... +${text.length - 200} karakter]` : text
  try {
    ownerChatMissingSink(
      `[notify-undelivered] Egy riasztás nem ment ki: a tulajdonosi chat nem oldható fel (${reason}). ` +
      'Óránként legfeljebb egy ilyen jelzés jön, a többi csak a naplóba kerül. ' +
      `A kihagyott riasztás eleje: ${preview}`,
    )
  } catch (err) {
    logger.warn({ err }, 'owner-chat-missing signal could not be delivered')
  }
}

// Owner-facing content (heartbeat digest, security events): always the owner
// chat, never rerouted by ALERT_CHAT_ID.
export async function notifyOwner(text: string, meta?: AlertMeta): Promise<boolean> {
  return discordOwner(text, meta)
}

async function discordOwner(text: string, meta?: AlertMeta): Promise<boolean> {
  const owner = resolveAlertDeliveryChat(undefined, CHANNEL_CHAT_ID, CHANNEL_PROVIDER)
  if (!CHANNEL_TOKEN || !owner.chatId) logAlertDelivery(meta, 'owner', 'skipped')
  if (!CHANNEL_TOKEN || !owner.chatId) {
    const reason = !CHANNEL_TOKEN ? 'nincs token' : `nincs tulajdonos-chat (${owner.reason})`
    logger.warn(`Channel ertesites kihagyva: ${reason}`)
    if (CHANNEL_TOKEN) signalOwnerChatMissing(text, owner.reason ?? 'ismeretlen ok')
    return false
  }
  return (await sendToChat(owner.chatId, text, 'owner', { meta, recipient: 'owner' })).sent
}

type SendTarget = 'owner' | 'alert'

/** The HTTP status in a provider send error ("Discord API 404: ..."), or null. */
function sendErrorStatus(err: unknown): number | null {
  const m = /Discord API (\d{3})\b/.exec(err instanceof Error ? err.message : String(err))
  return m ? Number(m[1]) : null
}

async function sendToChat(chatId: string, text: string, target: SendTarget, alert?: { meta?: AlertMeta; recipient: AlertRecipient }): Promise<ChannelSendResult> {
  if (!CHANNEL_TOKEN) {
    logger.warn('Channel ertesites kihagyva: nincs token')
    if (alert) logAlertDelivery(alert.meta, alert.recipient, 'skipped')
    return { sent: false, reason: 'no-token' }
  }

  const outbound = markIfTestRun(text)
  const provider = getProvider(CHANNEL_PROVIDER)
  const formatted = provider.formatMessage(outbound)
  const chunks = provider.splitMessage(formatted)

  let delivered = 0
  let lastError: unknown
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    const where = { provider: CHANNEL_PROVIDER, target, chunk: i + 1, chunks: chunks.length }
    try {
      const receipt = await provider.sendMessage(CHANNEL_TOKEN, chatId, chunk)
      delivered++
      logger.info({ ...where, status: receipt?.status ?? null, messageId: receipt?.messageId ?? null }, 'Channel ertesites elkuldve')
    } catch (err) {
      lastError = err
      const firstStatus = sendErrorStatus(err)
      try {
        const receipt = await provider.sendMessage(CHANNEL_TOKEN, chatId, chunk)
        delivered++
        logger.info(
          { ...where, status: receipt?.status ?? null, messageId: receipt?.messageId ?? null, plainTextRetry: true, firstStatus },
          'Channel ertesites elkuldve',
        )
      } catch (err2) {
        lastError = err2
        logger.warn({ ...where, firstStatus, retryStatus: sendErrorStatus(err2) }, 'Channel ertesites SIKERTELEN')
      }
    }
  }
  const failedChunks = chunks.length - delivered
  const outcome: AlertOutcome = failedChunks === 0 ? 'sent' : delivered > 0 ? 'partial' : 'failed'
  if (alert) logAlertDelivery(alert.meta, alert.recipient, outcome, chunks.length, failedChunks)
  if (delivered === 0) {
    if (chunks.length > 1) {
      logger.warn({ provider: CHANNEL_PROVIDER, target, chunks: chunks.length, status: sendErrorStatus(lastError) }, 'channel send failed on every chunk')
    }
    return { sent: false, reason: 'send-failed' }
  }
  if (delivered < chunks.length) {
    logger.warn({ provider: CHANNEL_PROVIDER, target, delivered, chunks: chunks.length, status: sendErrorStatus(lastError) },
      'channel send only partially delivered')
    return { sent: false, reason: 'partial' }
  }
  return { sent: true }
}

function logAlertDelivery(
  meta: AlertMeta | undefined,
  recipient: AlertRecipient,
  outcome: AlertOutcome,
  chunks = 0,
  failedChunks = 0,
): void {
  logger.info({ agent: meta?.agent ?? null, kind: meta?.kind ?? null, recipient, outcome, chunks, failedChunks }, 'alert delivery')
}

// Security-event notification (break-glass password reset, security:reset).
export async function notifySecurityEvent(text: string): Promise<void> {
  const hasChannel = !!CHANNEL_TOKEN && !!resolveAlertDeliveryChat(undefined, CHANNEL_CHAT_ID, CHANNEL_PROVIDER).chatId
  if (!hasChannel) return
  try {
    await notifyOwner(text)
  } catch {
    /* never let a notification failure break the recovery action itself */
  }
}
