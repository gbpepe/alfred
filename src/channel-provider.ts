import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { logger } from './logger.js'
import { splitMessage } from './format.js'
import { markIfTestRun } from './test-run-marker.js'
import { TOOL_TIMEOUTS } from './tool-timeouts.js'

export type ChannelProviderType = 'discord'

/**
 * What a successful send can tell about itself: the HTTP status of the answer
 * and the id the service gave the new message, when it gives one. Never the
 * chat or the text -- the channel log (notify.ts) records exactly this.
 */
export interface SendReceipt {
  status: number
  messageId?: string
}

export interface ChannelProvider {
  readonly type: ChannelProviderType
  readonly pluginId: string
  readonly pluginPaneId: string
  /** The MCP server name the installed plugin registers, as `/mcp reconnect <name>` takes it. Omitted when it is
   *  the same as pluginPaneId. */
  readonly mcpServerName?: string
  readonly envKeys: string[]
  readonly stateDir: string
  readonly chatIdFormat: string
  sendMessage(token: string, chatId: string, text: string, parseMode?: string, threadId?: string): Promise<SendReceipt | void>
  sendPhoto(token: string, chatId: string, photoPath: string, caption: string): Promise<void>
  validateToken(token: string): Promise<TokenValidation>
  formatMessage(text: string): string
  splitMessage(text: string): string[]
}

export interface TokenValidation {
  ok: boolean
  botName?: string
  error?: string
}

// -- Discord implementation --

const DISCORD_MAX_MESSAGE_LENGTH = 2000

function formatForDiscord(text: string): string {
  // Discord natively renders GFM markdown (bold, italic, code blocks, links).
  // Only convert task-list checkboxes which Discord does not support.
  let result = text
  result = result.replace(/^- \[ \]/gm, '☐')
  result = result.replace(/^- \[x\]/gm, '☑')
  return result
}

const discordProvider: ChannelProvider = {
  type: 'discord',
  pluginId: 'discord@claude-plugins-official',
  pluginPaneId: 'plugin:discord:discord',
  envKeys: ['DISCORD_BOT_TOKEN'],
  stateDir: 'discord',
  chatIdFormat: 'Discord channel ID (e.g. 1234567890123456789)',

  async sendMessage(token, chatId, text) {
    const resp = await fetch(`https://discord.com/api/v10/channels/${chatId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bot ${token}`,
      },
      body: JSON.stringify({ content: text }),
      signal: AbortSignal.timeout(TOOL_TIMEOUTS['discord']),
    })
    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      throw new Error(`Discord API ${resp.status}: ${body.slice(0, 200)}`)
    }
  },

  async sendPhoto(token, chatId, photoPath, caption) {
    const fileData = readFileSync(photoPath)
    const filename = photoPath.split('/').pop() || 'image.png'
    const boundary = '----FormBoundary' + Date.now()
    const parts: Buffer[] = []
    const payloadJson = JSON.stringify({
      content: caption || undefined,
      attachments: [{ id: '0', filename }],
    })
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\nContent-Type: application/json\r\n\r\n${payloadJson}\r\n`))
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files[0]"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`))
    parts.push(fileData)
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`))
    const body = Buffer.concat(parts)
    const resp = await fetch(`https://discord.com/api/v10/channels/${chatId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Authorization': `Bot ${token}`,
      },
      body,
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`Discord sendPhoto ${resp.status}: ${text.slice(0, 200)}`)
    }
  },

  async validateToken(token) {
    try {
      const resp = await fetch('https://discord.com/api/v10/users/@me', {
        headers: { 'Authorization': `Bot ${token}` },
      })
      const data = await resp.json() as { id?: string; username?: string }
      if (resp.ok && data.username) {
        return { ok: true, botName: data.username }
      }
      return { ok: false, error: 'Invalid bot token' }
    } catch {
      return { ok: false, error: 'Failed to connect to Discord API' }
    }
  },

  formatMessage: formatForDiscord,
  splitMessage: (text) => splitMessage(text, DISCORD_MAX_MESSAGE_LENGTH),
}

// -- Provider capabilities --

export interface ProviderCapabilities {
  needsBun: boolean
  subAgentDefault: 'main-provider' | 'none'
  directSend: boolean
}

export function providerCapabilities(_type: ChannelProviderType): ProviderCapabilities {
  return { needsBun: true, subAgentDefault: 'main-provider', directSend: true }
}

// -- Token resolution --

export function getChannelToken(_provider: ChannelProviderType, env: Record<string, string>): string {
  return env['DISCORD_BOT_TOKEN'] ?? ''
}

export function getChannelChatId(_provider: ChannelProviderType, env: Record<string, string>): string {
  return env['DISCORD_CHANNEL_ID'] ?? ''
}

// -- Provider registry --

// Every provider send is routed through the test-run marker: getProvider has
// many callers beyond notifyChannel (agent-process, channel-monitor, agent
// routes), and any of them reached from a test run must label its outbound
// message. markIfTestRun is a no-op in production and idempotent, so the
// wrapper is safe to layer under callers that already mark.
function withTestRunMarking(provider: ChannelProvider): ChannelProvider {
  return {
    ...provider,
    sendMessage: (token, chatId, text, parseMode, threadId) => threadId
      ? provider.sendMessage(token, chatId, markIfTestRun(text), parseMode, threadId)
      : provider.sendMessage(token, chatId, markIfTestRun(text), parseMode),
    sendPhoto: (token, chatId, photoPath, caption) =>
      provider.sendPhoto(token, chatId, photoPath, markIfTestRun(caption)),
  }
}

const markedProviders: Record<ChannelProviderType, ChannelProvider> = {
  discord: withTestRunMarking(discordProvider),
}

export function getProvider(type: ChannelProviderType): ChannelProvider {
  return markedProviders[type]
}

const KNOWN_PROVIDER_TYPES: readonly ChannelProviderType[] = ['discord']

export interface ProviderTypeResolution {
  /** The provider that will actually be used. */
  type: ChannelProviderType
  /** The configured value, trimmed. Empty string when nothing was configured. */
  raw: string
  /** A value WAS configured, and it is not one this build knows. */
  unrecognised: boolean
}

export function resolveProviderType(envValue: string | undefined): ProviderTypeResolution {
  const raw = (envValue ?? '').trim()
  const known = KNOWN_PROVIDER_TYPES.find((t) => t === raw)
  if (known) return { type: known, raw, unrecognised: false }
  return { type: 'discord', raw, unrecognised: raw.length > 0 }
}

const announcedProviderValues = new Set<string>()

export function getProviderType(envValue: string | undefined): ChannelProviderType {
  const resolved = resolveProviderType(envValue)
  if (resolved.unrecognised && !announcedProviderValues.has(resolved.raw)) {
    announcedProviderValues.add(resolved.raw)
    logger.warn(
      { configured: resolved.raw, using: resolved.type, known: KNOWN_PROVIDER_TYPES },
      `Unknown channel provider "${resolved.raw}" -- falling back to "${resolved.type}". This is NOT what was configured: ` +
        `the session will come up on the ${resolved.type} plugin. There is no "none" provider; a channel-less agent is not a supported configuration today.`,
    )
  }
  return resolved.type
}

/** Test seam: the announce-once memory is process-wide by design. */
export function resetProviderTypeAnnouncements(): void {
  announcedProviderValues.clear()
}

// Compiled location is dist/channel-provider.js, so '..' is the install root --
// the same convention config.ts uses for PROJECT_ROOT. Computed locally because
// config.ts imports this module (importing it back would be circular).
const INSTALL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** DISCORD_STATE_DIR -- the env var the channel plugin itself honours. */
export function channelStateDirEnvVar(provider: ChannelProviderType): string {
  return `${provider.toUpperCase()}_STATE_DIR`
}

export function resolveMainChannelStateDir(opts: {
  envOverride: string | undefined
  installScoped: string
  legacy: string
  hasEnvFile: (dir: string) => boolean
}): string {
  if (opts.envOverride) return opts.envOverride
  if (opts.hasEnvFile(opts.legacy) && !opts.hasEnvFile(opts.installScoped)) return opts.legacy
  return opts.installScoped
}

export function channelStateDir(provider: ChannelProviderType, agentDir?: string): string {
  const subdir = 'discord'
  if (agentDir) return join(agentDir, '.claude', 'channels', subdir)
  return resolveMainChannelStateDir({
    envOverride: process.env[channelStateDirEnvVar(provider)],
    installScoped: join(INSTALL_ROOT, '.claude', 'channels', subdir),
    legacy: join(homedir(), '.claude', 'channels', subdir),
    hasEnvFile: (dir) => existsSync(join(dir, '.env')),
  })
}

export function readChannelToken(_provider: ChannelProviderType, envFilePath: string): string | null {
  if (!existsSync(envFilePath)) return null
  let content: string
  try {
    content = readFileSync(envFilePath, 'utf-8')
  } catch {
    return null
  }
  const match = content.match(/^\s*DISCORD_BOT_TOKEN=(.+)$/m)
  return match ? match[1].trim() : null
}

export function readChannelEnv(envFilePath: string, keys: readonly string[]): Record<string, string> {
  let content: string
  try {
    content = readFileSync(envFilePath, 'utf-8')
  } catch {
    return {}
  }
  const out: Record<string, string> = {}
  for (const key of keys) {
    const match = content.match(new RegExp(`^\\s*${key}=(.+)$`, 'm'))
    if (match) out[key] = match[1].trim()
  }
  return out
}
