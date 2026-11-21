// Where does a one-way notification go?
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHANNEL_CHAT_ID, CHANNEL_PROVIDER } from './config.js'
import { channelStateDir, type ChannelProviderType } from './channel-provider.js'
import { logger } from './logger.js'
import { alertChatFormatError, alertChatValue, OWNER_ALERT_CHAT_KEY } from './alert-chat-format.js'

/**
 * The .env value that names the owner chat for Discord (`DISCORD_CHANNEL_ID`,
 * surfaced as `CHANNEL_CHAT_ID`).
 */
export function configuredOwnerChatFor(
  _provider: ChannelProviderType = CHANNEL_PROVIDER,
  env: { channelChatId?: string } = { channelChatId: CHANNEL_CHAT_ID },
): string {
  return env.channelChatId ?? ''
}

/**
 * Normalise a configured chat id to "set" or "not set".
 * `"0"` is the installer placeholder and is treated as unset.
 */
export function normalizeChatId(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim()
  if (!v) return null
  if (v === '0') return null
  return v
}

/**
 * The chat id the owner actually reads, or null when this install has none.
 *
 * Order: the configured value first, then the main agent's Discord access.json
 * allowlist (`allowFrom`, then `groups`). Returning null skips the send.
 */
export function resolveOwnerChatId(
  readAccessFile: (path: string) => string = (p) => readFileSync(p, 'utf-8'),
  configured: string | null = CHANNEL_CHAT_ID,
  provider: ChannelProviderType = 'discord',
): string | null {
  const fromEnv = normalizeChatId(configured)
  if (fromEnv) return fromEnv
  try {
    const raw = JSON.parse(readAccessFile(join(channelStateDir(provider), 'access.json'))) as Record<string, unknown>
    if (Array.isArray(raw.allowFrom)) {
      for (const entry of raw.allowFrom) {
        const id = normalizeChatId(typeof entry === 'number' ? String(entry) : (entry as string))
        if (id) return id
      }
    }
    const groups = raw['groups']
    if (groups && typeof groups === 'object') {
      for (const key of Object.keys(groups as Record<string, unknown>)) {
        const id = normalizeChatId(key)
        if (id) return id
      }
    }
  } catch {
    // No access.json, unreadable, or not JSON: no owner chat.
  }
  return null
}

export type AlertOwnerChat = { chatId: string; reason?: undefined } | { chatId: null; reason: string }

/**
 * The owner chat for an ALERT -- stricter than resolveOwnerChatId.
 *
 * The configured .env value wins. Otherwise the access.json fallback applies only
 * when the DM allowlist (`allowFrom`) holds EXACTLY ONE usable entry.
 */
export function resolveAlertOwnerChat(
  readAccessFile: (path: string) => string = (p) => readFileSync(p, 'utf-8'),
  configured: string | null = CHANNEL_CHAT_ID,
  provider: ChannelProviderType = 'discord',
): AlertOwnerChat {
  const fromEnv = normalizeChatId(configured)
  if (fromEnv) return { chatId: fromEnv }
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(readAccessFile(join(channelStateDir(provider), 'access.json'))) as Record<string, unknown>
  } catch {
    return { chatId: null, reason: 'no owner chat: .env placeholder/empty and no readable access.json' }
  }
  return soleDmOwner(raw)
}

/** The exactly-one-DM-entry rule on a parsed access.json. */
export function soleDmOwner(raw: Record<string, unknown> | null): AlertOwnerChat {
  const entries = new Set<string>()
  if (raw && Array.isArray(raw.allowFrom)) {
    for (const entry of raw.allowFrom) {
      const id = normalizeChatId(typeof entry === 'number' ? String(entry) : typeof entry === 'string' ? entry : '')
      if (id && !id.startsWith('-')) entries.add(id)
    }
  }
  if (entries.size === 1) return { chatId: [...entries][0] }
  if (entries.size === 0) {
    return { chatId: null, reason: 'no owner chat: .env placeholder/empty and access.json has no DM entry (groups/channels are never used)' }
  }
  return { chatId: null, reason: `no owner chat: .env placeholder/empty and access.json has ${entries.size} DM entries, refusing to guess` }
}

// ---------------------------------------------------------------- OWNER_ALERT_CHAT_ID

export type OwnerAlertChat = { chatId: string; invalid?: undefined } | { chatId: null; invalid?: string }

export const OVERRIDES_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'store', 'config-overrides.json')
export function readOverrideValue(key: string, path: string = OVERRIDES_FILE): string | number | undefined {
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
    const v = data[key]
    return typeof v === 'string' || typeof v === 'number' ? v : undefined
  } catch {
    return undefined
  }
}

const reportedAlertChatErrors = new Set<string>()

export function readOwnerAlertChat(
  provider: ChannelProviderType,
  read: () => unknown = () => readOverrideValue(OWNER_ALERT_CHAT_KEY),
  installProvider: ChannelProviderType = CHANNEL_PROVIDER,
): OwnerAlertChat {
  if (provider !== installProvider) return { chatId: null }
  let raw: unknown
  try { raw = read() } catch { return { chatId: null } }
  const value = alertChatValue(raw)
  if (value === null) return { chatId: null }
  const err = alertChatFormatError(provider, value)
  if (!err) return { chatId: value }
  const seen = `${provider}\u0000${value}`
  if (!reportedAlertChatErrors.has(seen)) {
    reportedAlertChatErrors.add(seen)
    logger.error({ key: OWNER_ALERT_CHAT_KEY, provider }, `${OWNER_ALERT_CHAT_KEY} is set but is not a ${provider} chat id -- NOT used; the alerts follow the old rule until it is fixed on the settings page`)
  }
  return { chatId: null, invalid: err }
}

/** The alert resolver with the owner's OWNER_ALERT_CHAT_ID in front (notify.ts). */
export function resolveAlertDeliveryChat(
  readAccessFile: (path: string) => string = (p) => readFileSync(p, 'utf-8'),
  configured: string | null = CHANNEL_CHAT_ID,
  provider: ChannelProviderType = CHANNEL_PROVIDER,
  override: OwnerAlertChat = readOwnerAlertChat(provider),
): AlertOwnerChat {
  if (override.chatId) return { chatId: override.chatId }
  const base = resolveAlertOwnerChat(readAccessFile, configured, provider)
  if (base.chatId === null && override.invalid) {
    return { chatId: null, reason: `${base.reason}; ${OWNER_ALERT_CHAT_KEY} is set but invalid for ${provider}` }
  }
  return base
}

/** The owner's OWNER_ALERT_CHAT_ID for a DELIVERY on `provider`, or null (unset, invalid, or another provider).
 *  Never for deciding who the owner is. */
export function ownerAlertChatOverride(provider: ChannelProviderType = 'discord'): string | null {
  return readOwnerAlertChat(provider).chatId
}
