// Who is the OWNER for the chat commands.
//
// Discord owner for the slash / chat commands -- explicit DISCORD_OWNER_USER_ID (an overrides-only registry key;
// the same value the Discord overlay's tool-permission check reads), else a positive configured CHANNEL_CHAT_ID,
// else the sole DM entry of access.json.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHANNEL_CHAT_ID } from './config.js'
import { channelStateDir } from './channel-provider.js'
import { normalizeChatId, soleDmOwner } from './owner-chat.js'
import { logger } from './logger.js'

export const OVERRIDES_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'store', 'config-overrides.json')

export const DISCORD_OWNER_KEY = 'DISCORD_OWNER_USER_ID'
export const DISCORD_USER_ID_RX = /^[1-9][0-9]{16,19}$/
export function readDiscordOwnerSetting(path: string = OVERRIDES_FILE): string | null {
  try {
    const v = (JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>)[DISCORD_OWNER_KEY]
    const s = typeof v === 'string' || typeof v === 'number' ? String(v).trim() : ''
    return DISCORD_USER_ID_RX.test(s) ? s : null
  } catch {
    return null
  }
}

export type OwnerIdentity =
  | { chatId: string; source: 'setting' | 'allowed-chat-id' | 'sole-dm'; ambiguous?: undefined }
  | { chatId: null; source: null; ambiguous: boolean; reason: string }

const reportedBadSetting = new Set<string>()

export function resolveOwnerIdentity(
  readAccessFile: (path: string) => string = (p) => readFileSync(p, 'utf-8'),
  configured: string | null = CHANNEL_CHAT_ID,
  explicit: string = readDiscordOwnerSetting() ?? '',
): OwnerIdentity {
  const setting = explicit.trim()
  if (setting && setting !== '0') {
    if (DISCORD_USER_ID_RX.test(setting)) return { chatId: setting, source: 'setting' }
    if (!reportedBadSetting.has(setting)) {
      reportedBadSetting.add(setting)
      logger.error({ key: DISCORD_OWNER_KEY }, `${DISCORD_OWNER_KEY} is set but is not a valid Discord user id -- NOT used`)
    }
  }
  const fromEnv = normalizeChatId(configured)
  if (fromEnv && DISCORD_USER_ID_RX.test(fromEnv)) return { chatId: fromEnv, source: 'allowed-chat-id' }
  let raw: Record<string, unknown> | null
  try {
    raw = JSON.parse(readAccessFile(join(channelStateDir('discord'), 'access.json'))) as Record<string, unknown>
  } catch {
    return { chatId: null, source: null, ambiguous: false, reason: 'no owner: no explicit owner id and no readable access.json' }
  }
  const sole = soleDmOwner(raw)
  if (sole.chatId) return { chatId: sole.chatId, source: 'sole-dm' }
  const reason = sole.reason ?? 'no owner'
  const ambiguous = /\d+ DM entries, refusing to guess/.test(reason)
  return { chatId: null, source: null, ambiguous, reason }
}

/** The generic answer to a chat command when no owner can be named: it says nothing about who the owner is. */
export const OWNER_UNSET_REPLY = 'Ez a parancs most nem futtatható; a gazda a dashboardon tudja beállítani.'

/** The dashboard / doctor line for an install whose chat commands are off because of several DMs; null otherwise. */
export function ownerUnsetNotice(identity: OwnerIdentity): string | null {
  if (identity.chatId !== null || !identity.ambiguous) return null
  return `A chat-parancsok le vannak tiltva: több párosított DM van, és nincs megadva, melyik a gazdáé. Beállítás: Dashboard -> Beállítások -> ${DISCORD_OWNER_KEY} (a saját Discord-felhasználói azonosítód).`
}
