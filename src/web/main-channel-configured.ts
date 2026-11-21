// CHANNELUNCONF1110: is the main agent's primary channel configured?
// The TS twin of scripts/main-channel-configured.sh.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readChannelToken, resolveMainChannelStateDir, type ChannelProviderType } from '../channel-provider.js'
import { PROJECT_ROOT, STORE_DIR } from '../config.js'

/** The providers this rule covers, with the .env key whose presence makes the channel configured. */
export const MAIN_CHANNEL_TOKEN_KEYS: Readonly<Record<string, string>> = Object.freeze({
  discord: 'DISCORD_BOT_TOKEN',
})

/** The marker channels.sh writes when it launched an unconfigured session (the provider on one line). */
export const MAIN_CHANNEL_UNCONFIGURED_MARKER = join(STORE_DIR, '.channel-unconfigured')

/** The launch rule (the shell twin's main_channel_unconfigured): true when the provider needs a token and none is set
 *  in the install-scoped .env, or in the legacy ~/.claude one while only that exists (channels.sh migrates it). */
export function mainChannelUnconfigured(
  provider: string,
  opts: { installRoot?: string; home?: string } = {},
): boolean {
  if (!Object.prototype.hasOwnProperty.call(MAIN_CHANNEL_TOKEN_KEYS, provider)) return false
  const dir = resolveMainChannelStateDir({
    envOverride: undefined,
    installScoped: join(opts.installRoot ?? PROJECT_ROOT, '.claude', 'channels', provider),
    legacy: join(opts.home ?? homedir(), '.claude', 'channels', provider),
    hasEnvFile: (d) => existsSync(join(d, '.env')),
  })
  const token = readChannelToken(provider as ChannelProviderType, join(dir, '.env'))
  return !token
}

/** How the RUNNING session stands: the provider channels.sh launched without its channel, or null. */
export function readMainChannelUnconfiguredMarker(path: string = MAIN_CHANNEL_UNCONFIGURED_MARKER): string | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch {
    return null
  }
  const provider = raw.split('\n')[0]?.trim() ?? ''
  return Object.prototype.hasOwnProperty.call(MAIN_CHANNEL_TOKEN_KEYS, provider) ? provider : null
}

/** The monitor's question: does the RUNNING main session stand without its channel by design? */
export function mainSessionRunsUnconfigured(
  provider: string,
  opts: { markerPath?: string; installRoot?: string; home?: string } = {},
): boolean {
  return readMainChannelUnconfiguredMarker(opts.markerPath) === provider && mainChannelUnconfigured(provider, opts)
}
