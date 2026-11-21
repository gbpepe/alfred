// Provider-specific poller cmdline matcher for Discord.
import type { ChannelProviderType } from '../channel-provider.js'

const RUNTIME_TOKEN_RX = /\b(bun|node)\b/

const SLUG_RX: Record<ChannelProviderType, RegExp> = {
  discord: /\/discord(?:\/|\s|$)/,
}

/**
 * Pure: does this process command line look like a channel poller for `provider`?
 */
export function matchesProviderPollerCmd(
  cmd: string,
  provider: ChannelProviderType,
): boolean {
  if (!cmd) return false
  if (!RUNTIME_TOKEN_RX.test(cmd)) return false
  return SLUG_RX[provider].test(cmd)
}
