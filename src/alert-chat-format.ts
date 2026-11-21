// OWNER_ALERT_CHAT_ID: the chat the owner's alerts and owner-facing deliveries go to, set on the
// dashboard's settings page. Pure on purpose: the settings registry validates with it, and the registry
// may not import config.ts (config.ts imports the registry). scripts/lib/owner-chat.sh and
// scripts/lib/owner_chat.py carry the same patterns (src/__tests__/owner-chat-parity.test.ts).
export const OWNER_ALERT_CHAT_KEY = 'OWNER_ALERT_CHAT_ID'

export type AlertChatProvider = 'discord'

// A Discord snowflake: a DM channel and a server channel share the same numeric shape,
// so the settings copy instructs the owner to provide a DM channel ID.
export const ALERT_CHAT_FORMATS: Readonly<Record<AlertChatProvider, RegExp>> = Object.freeze({
  discord: /^[1-9][0-9]{14,24}$/,
})

const PROVIDERS = Object.keys(ALERT_CHAT_FORMATS) as AlertChatProvider[]

/** CHANNEL_PROVIDER as the install reads it (channel-provider.ts resolveProviderType): unknown or empty is discord. */
export function alertChatProviderOf(raw: string | undefined | null): AlertChatProvider {
  const v = String(raw ?? '').trim()
  return (PROVIDERS as string[]).includes(v) ? (v as AlertChatProvider) : 'discord'
}

/** The value as stored, normalised: null when unset (empty or the "0" placeholder), else the trimmed id. */
export function alertChatValue(raw: unknown): string | null {
  const v = String(raw ?? '').trim()
  return v === '' || v === '0' ? null : v
}

/** null when `raw` is unset or a valid personal chat id for `provider`; else the reason, Hungarian then English. */
export function alertChatFormatError(provider: AlertChatProvider, raw: unknown): string | null {
  const v = alertChatValue(raw)
  if (v === null) return null
  if (ALERT_CHAT_FORMATS[provider].test(v)) return null
  return `Személyes chat-azonosító kell (${provider}): ${EXAMPLES[provider].hu}. Csoport vagy csatorna nem lehet, mert ott a gazda riasztásait és a jóváhagyások szövegét mindenki látná. / ` +
    `A personal chat id is required (${provider}): ${EXAMPLES[provider].en}. A group or channel is not allowed: every member would read the owner's alerts and the approval texts.`
}

const EXAMPLES: Readonly<Record<AlertChatProvider, { hu: string; en: string }>> = Object.freeze({
  discord: { hu: 'a DM-csatornád azonosítója, pl. 1234567890123456789 (az alakból nem látszik, hogy DM-e: DM-et adj meg)', en: 'your DM channel id, e.g. 1234567890123456789 (the shape cannot show it is a DM: give a DM)' },
})
