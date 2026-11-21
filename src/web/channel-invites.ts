// Channel invite tokens for pairing management.
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { logger } from '../logger.js'
import { channelStateDir, type ChannelProviderType } from '../channel-provider.js'
import { agentDir, readJsonObjectForWrite } from './agent-config.js'
import { atomicWriteFileSync } from './atomic-write.js'

interface InviteEntry {
  createdAt: number
  expiresAt: number
  used: boolean
  usedBy?: string
  usedAt?: number
}

// access.json is co-owned by the channel plugin. We only ever touch the fields
// the plugin also understands (dmPolicy, allowFrom, pending); invite tokens live
// in the sidecar InvitesFile so the plugin can't clobber them.
interface AccessFile {
  dmPolicy?: 'pairing' | 'allowlist' | 'disabled'
  allowFrom?: string[]
  groups?: Record<string, unknown>
  pending?: Record<string, { senderId: string; chatId: string; createdAt: number; expiresAt: number; replies?: number }>
}

interface InvitesFile {
  invites?: Record<string, InviteEntry>
}

const INVITE_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

export function agentChannelDir(name: string, mainAgentId: string, provider: ChannelProviderType): string {
  return name === mainAgentId
    ? channelStateDir(provider)
    : channelStateDir(provider, agentDir(name))
}

function invitesPathFor(accessPath: string): string {
  return join(accessPath, '..', 'invites.json')
}

function readAccess(path: string): AccessFile {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as AccessFile
  } catch {
    return {}
  }
}

function writeAccess(path: string, data: AccessFile): void {
  mkdirSync(join(path, '..'), { recursive: true })
  atomicWriteFileSync(path, JSON.stringify(data, null, 2))
}

function readInvites(path: string): InvitesFile {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as InvitesFile
  } catch {
    return {}
  }
}

function writeInvites(path: string, data: InvitesFile): void {
  mkdirSync(join(path, '..'), { recursive: true })
  atomicWriteFileSync(path, JSON.stringify(data, null, 2))
}

function pruneInvites(store: InvitesFile, now: number): boolean {
  if (!store.invites) return false
  let mutated = false
  for (const [token, inv] of Object.entries(store.invites)) {
    if (inv.expiresAt < now && !inv.used) {
      delete store.invites[token]
      mutated = true
    }
  }
  return mutated
}

function activeInviteCount(store: InvitesFile, now: number): number {
  if (!store.invites) return 0
  let n = 0
  for (const inv of Object.values(store.invites)) {
    if (!inv.used && inv.expiresAt >= now) n++
  }
  return n
}

export interface CreateInviteResult {
  token: string
  expiresAt: number
  deepLink?: string
}

export function createInvite(
  accessPath: string,
  _botUsername: string | undefined,
  _provider: ChannelProviderType = 'discord',
  ttlMs: number = INVITE_DEFAULT_TTL_MS,
): CreateInviteResult {
  const invitesPath = invitesPathFor(accessPath)
  const store = readJsonObjectForWrite(invitesPath) as InvitesFile
  const access = readJsonObjectForWrite(accessPath) as AccessFile
  const now = Date.now()
  pruneInvites(store, now)

  const token = randomBytes(16).toString('base64url').slice(0, 22)
  const entry: InviteEntry = {
    createdAt: now,
    expiresAt: now + ttlMs,
    used: false,
  }
  store.invites = store.invites || {}
  store.invites[token] = entry
  writeInvites(invitesPath, store)

  if (access.dmPolicy !== 'disabled') {
    access.dmPolicy = 'pairing'
    writeAccess(accessPath, access)
  }

  return { token, expiresAt: entry.expiresAt }
}

export function listInvites(accessPath: string): Array<{ token: string; createdAt: number; expiresAt: number; used: boolean; usedBy?: string; deepLink?: string }> {
  const invitesPath = invitesPathFor(accessPath)
  const store = readInvites(invitesPath)
  const now = Date.now()
  if (pruneInvites(store, now)) writeInvites(invitesPath, store)
  if (!store.invites) return []
  return Object.entries(store.invites).map(([token, inv]) => ({
    token,
    createdAt: inv.createdAt,
    expiresAt: inv.expiresAt,
    used: inv.used,
    usedBy: inv.usedBy,
  }))
}

export function revokeInvite(accessPath: string, token: string): boolean {
  const invitesPath = invitesPathFor(accessPath)
  const store = readInvites(invitesPath)
  if (!store.invites?.[token]) return false
  delete store.invites[token]
  writeInvites(invitesPath, store)
  if (activeInviteCount(store, Date.now()) === 0) {
    const access = readAccess(accessPath)
    if (access.dmPolicy === 'pairing') {
      access.dmPolicy = 'allowlist'
      writeAccess(accessPath, access)
    }
  }
  return true
}

export function runInviteMonitorTick(mainAgentId: string, agentsRoot: string): void {
  const providerTypes: ChannelProviderType[] = ['discord']

  for (const provider of providerTypes) {
    const targets: Array<{ name: string; accessPath: string }> = []
    const mainAccess = join(channelStateDir(provider), 'access.json')
    if (existsSync(mainAccess)) targets.push({ name: mainAgentId, accessPath: mainAccess })
    if (existsSync(agentsRoot)) {
      let entries: string[]
      try { entries = readdirSync(agentsRoot) } catch { entries = [] }
      for (const e of entries) {
        const p = join(channelStateDir(provider, join(agentsRoot, e)), 'access.json')
        if (existsSync(p)) targets.push({ name: e, accessPath: p })
      }
    }

    for (const { accessPath } of targets) {
      const invitesPath = invitesPathFor(accessPath)
      const store = readInvites(invitesPath)
      if (!store.invites) continue

      const access = readAccess(accessPath)
      const now = Date.now()
      if (pruneInvites(store, now)) writeInvites(invitesPath, store)

      const live = Object.entries(store.invites)
        .filter(([, inv]) => !inv.used && inv.expiresAt >= now)
      if (live.length === 0) {
        if (activeInviteCount(store, now) === 0 && access.dmPolicy === 'pairing') {
          access.dmPolicy = 'allowlist'
          writeAccess(accessPath, access)
        }
      }
    }
  }
}

let inviteMonitorInterval: NodeJS.Timeout | null = null

export function startInviteMonitor(mainAgentId: string, agentsRoot: string, intervalMs = 3000): void {
  if (inviteMonitorInterval) return
  try { runInviteMonitorTick(mainAgentId, agentsRoot) } catch (err) {
    logger.error({ err }, 'invite-monitor first tick failed')
  }
  inviteMonitorInterval = setInterval(() => {
    try {
      runInviteMonitorTick(mainAgentId, agentsRoot)
    } catch (err) {
      logger.error({ err }, 'invite-monitor tick failed')
    }
  }, intervalMs)
  logger.info({ intervalMs }, 'Channel invite monitor started')
}

export function stopInviteMonitor(): void {
  if (inviteMonitorInterval) {
    clearInterval(inviteMonitorInterval)
    inviteMonitorInterval = null
  }
}
