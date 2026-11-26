import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { channelStateDir } from '../channel-provider.js'
import { logger } from '../logger.js'
import { atomicWriteFileSync } from '../web/atomic-write.js'
import {
  loadAlfredAgentsConfig,
  resolveGlobalAllowedUserIds,
  type AlfredAgentsConfig,
  type LoadAgentsConfigOptions,
} from './agents-config.js'

export * from './agents-config.js'
export * from './circuit-breaker.js'
export * from './cli-manager.js'
export * from './cli-profile-manager.js'
export * from './cli-runner.js'
export * from './tool-executor.js'
export * from './model-router.js'
export * from './discord-adapter.js'
export * from './discord-gateway.js'
export * from './runtime-env.js'
export * from './vertex-auth.js'
export * from './system-monitor.js'
export * from './housekeeper.js'
export * from './batch-runner.js'
export * from './module-manager.js'
export * from './module-wizard.js'

interface DiscordAccessFile {
  dmPolicy?: 'pairing' | 'allowlist' | 'disabled'
  allowFrom?: string[]
  groups?: Record<string, { requireMention?: boolean; allowFrom?: string[] }>
  pending?: Record<string, unknown>
  invites?: Record<string, unknown>
}

/**
 * Synchronizes Alfred's `ALLOWED_USER_IDS` and per-agent Discord channel mappings
 * from `config/agents.json` into the Alfred Discord plugin's `access.json` file.
 */
export function syncAlfredDiscordAccess(
  agentsConfig: AlfredAgentsConfig,
  opts: { discordDir?: string; env?: Record<string, string | undefined> } = {},
): { channelsSynced: string[]; usersSynced: string[] } {
  const envDiscordDir = (opts.env?.['DISCORD_STATE_DIR'] ?? '').trim()
  const dir = opts.discordDir ?? (envDiscordDir || channelStateDir('discord'))
  const accessPath = join(dir, 'access.json')
  const globalUsers = resolveGlobalAllowedUserIds(opts.env)

  let access: DiscordAccessFile
  if (existsSync(accessPath)) {
    try {
      access = JSON.parse(readFileSync(accessPath, 'utf-8')) as DiscordAccessFile
    } catch {
      logger.warn({ accessPath }, 'alfred-discord-sync: access.json unparseable, skipping sync')
      return { channelsSynced: [], usersSynced: [] }
    }
  } else {
    access = { dmPolicy: 'allowlist', allowFrom: [], groups: {}, pending: {} }
  }

  const allowFromSet = new Set<string>(Array.isArray(access.allowFrom) ? access.allowFrom : [])
  for (const uid of globalUsers) allowFromSet.add(uid)
  for (const agent of agentsConfig.agents) {
    for (const uid of agent.allowedUserIds) allowFromSet.add(uid)
  }
  access.allowFrom = [...allowFromSet]

  access.groups = access.groups ?? {}
  const channelsSynced: string[] = []
  for (const agent of agentsConfig.agents) {
    const chId = agent.discordChannelId.trim()
    if (!chId || chId.startsWith('${')) continue
    const effectiveUsers = agent.allowedUserIds.length > 0 ? agent.allowedUserIds : globalUsers
    access.groups[chId] = {
      requireMention: false,
      allowFrom: [...effectiveUsers],
    }
    channelsSynced.push(chId)
  }

  mkdirSync(dir, { recursive: true })
  atomicWriteFileSync(accessPath, JSON.stringify(access, null, 2))

  return {
    channelsSynced,
    usersSynced: access.allowFrom,
  }
}

/**
 * Bootstraps the Alfred Core subsystem:
 * - Loads `config/agents.json` (and each agent's `SOUL.md`)
 * - Provisions isolated `workspaces/` directories
 * - Syncs multi-user `ALLOWED_USER_IDS` and Discord channels into `access.json`
 */
export function bootAlfredCore(opts: LoadAgentsConfigOptions & { discordDir?: string } = {}): AlfredAgentsConfig | null {
  try {
    const cfg = loadAlfredAgentsConfig(opts)
    syncAlfredDiscordAccess(cfg, { discordDir: opts.discordDir, env: opts.env })
    logger.info(
      {
        agents: cfg.agents.map((a) => ({
          id: a.id,
          provider: a.provider,
          model: a.model,
          channel: a.channelName,
          tools: a.tools,
          dailyBudgetUsd: a.dailyBudgetUsd,
        })),
        runtimeMode: cfg.global.runtimeMode,
        budgetMultiplier: cfg.global.budgetMultiplier,
        workspacesRoot: cfg.global.workspacesRoot,
        globalDailyBudgetUsd: cfg.global.dailyBudgetUsd,
      },
      'Alfred Core initialized',
    )
    return cfg
  } catch (err) {
    logger.warn({ err }, 'Alfred Core bootstrap skipped or failed')
    return null
  }
}
