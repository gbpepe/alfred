import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { channelStateDir } from '../channel-provider.js'
import { agentDir, readFileOr } from './agent-config.js'

export function readAgentDiscordConfig(name: string): { hasDiscord: boolean; botUsername?: string } {
  const envPath = join(agentDir(name), '.claude', 'channels', 'discord', '.env')
  if (!existsSync(envPath)) return { hasDiscord: false }
  const content = readFileOr(envPath, '')
  const tokenMatch = content.match(/DISCORD_BOT_TOKEN=(.+)/)
  if (!tokenMatch || !tokenMatch[1].trim()) return { hasDiscord: false }
  return { hasDiscord: true }
}

export function readAlfredDiscordConfig(): { hasDiscord: boolean } {
  const envPath = join(channelStateDir('discord'), '.env')
  if (!existsSync(envPath)) return { hasDiscord: false }
  const tokenMatch = readFileOr(envPath, '').match(/DISCORD_BOT_TOKEN=(.+)/)
  return { hasDiscord: !!tokenMatch?.[1]?.trim() }
}
