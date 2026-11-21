import { isAbsolute, join, resolve } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { readEnvFile } from '../env.js'

export type AlfredRuntimeMode = 'production' | 'test' | 'ops'

export interface DiscordPresencePayload {
  since: null
  activities: Array<{ name: string; type: number }>
  status: 'online' | 'idle' | 'dnd'
  afk: boolean
}

export interface AlfredRuntimeEnv {
  mode: AlfredRuntimeMode
  isTest: boolean
  isOps: boolean
  dbPath: string
  workspacesDir?: string
  budgetMultiplier: number
  enabledAgentIds?: string[]
  testReplyPrefix: string
  discordStateDir?: string
  discordPresence: DiscordPresencePayload
}

export const DEFAULT_TEST_REPLY_PREFIX = '🧪 [TEST] '

/**
 * Parses `ALFRED_ENV` into one of Alfred's 3 runtime modes (`production` | `test` | `ops`).
 * Legacy OS-platform overrides (`macos`, `linux-server`, `linux-gui`) safely default to `production`.
 */
export function parseAlfredEnvMode(raw: string | undefined): AlfredRuntimeMode {
  const v = (raw ?? '').trim().toLowerCase()
  if (v === 'test' || v === 'staging') return 'test'
  if (v === 'ops') return 'ops'
  return 'production'
}

/**
 * Resolves and validates `ALFRED_BUDGET_MULTIPLIER` (fail-closed outside `(0, 10]`).
 */
export function resolveBudgetMultiplier(raw: string | undefined): number {
  const clean = (raw ?? '').trim()
  if (!clean) return 1.0
  const parsed = Number(clean)
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 10) {
    throw new Error(`Invalid ALFRED_BUDGET_MULTIPLIER "${raw}": must be a finite number in (0, 10]`)
  }
  return parsed
}

/**
 * Parses `ALFRED_ENABLED_AGENTS` (comma- or whitespace-separated list of agent IDs).
 */
export function parseEnabledAgentIds(raw: string | undefined): string[] | undefined {
  const clean = (raw ?? '').trim()
  if (!clean) return undefined
  const out: string[] = []
  for (const part of clean.split(/[\s,]+/)) {
    const id = part.trim()
    if (id && !out.includes(id)) {
      out.push(id)
    }
  }
  return out.length > 0 ? out : undefined
}

/**
 * Resolves `ALFRED_DB_PATH` relative to `projectRoot` (defaulting to `store/alfred.db`).
 * Preserves `:memory:` as-is for tests.
 */
export function resolveAlfredDbPath(
  raw: string | undefined,
  projectRoot: string = PROJECT_ROOT,
): string {
  const clean = (raw ?? '').trim()
  if (!clean) return join(projectRoot, 'store', 'alfred.db')
  if (clean === ':memory:') return ':memory:'
  return isAbsolute(clean) ? resolve(clean) : resolve(projectRoot, clean)
}

/**
 * Builds the Discord Gateway v10 IDENTIFY `presence` object matching the active runtime mode.
 */
export function buildDiscordPresence(mode: AlfredRuntimeMode): DiscordPresencePayload {
  if (mode === 'test') {
    return {
      since: null,
      activities: [{ name: '[TEST] Alfred Staging', type: 3 }],
      status: 'idle',
      afk: false,
    }
  }
  if (mode === 'ops') {
    return {
      since: null,
      activities: [{ name: '[OPS] Alfred Control Plane', type: 3 }],
      status: 'online',
      afk: false,
    }
  }
  return {
    since: null,
    activities: [{ name: 'Alfred Production', type: 3 }],
    status: 'online',
    afk: false,
  }
}

/**
 * Prepends the configured staging prefix (default `🧪 [TEST] `) in `test` mode idempotently.
 */
export function prefixTestReply(
  text: string,
  runtimeEnv: Pick<AlfredRuntimeEnv, 'mode' | 'testReplyPrefix'>,
): string {
  if (runtimeEnv.mode !== 'test' || !runtimeEnv.testReplyPrefix) return text
  if (text.startsWith(runtimeEnv.testReplyPrefix)) return text
  return `${runtimeEnv.testReplyPrefix}${text}`
}

/**
 * Resolves Alfred's full runtime environment settings from an explicit env dictionary
 * (falling back to `.env` + `process.env` only when `envOverride` is omitted).
 */
export function resolveAlfredRuntimeEnv(
  envOverride?: Record<string, string | undefined>,
  projectRoot: string = PROJECT_ROOT,
): AlfredRuntimeEnv {
  const envMap = envOverride ?? { ...readEnvFile(), ...process.env }
  const mode = parseAlfredEnvMode(envMap['ALFRED_ENV'])
  const dbPath = resolveAlfredDbPath(envMap['ALFRED_DB_PATH'], projectRoot)
  const workspacesRaw = (envMap['ALFRED_WORKSPACES_DIR'] ?? '').trim()
  const workspacesDir = workspacesRaw || undefined
  const budgetMultiplier = resolveBudgetMultiplier(envMap['ALFRED_BUDGET_MULTIPLIER'])
  const enabledAgentIds = parseEnabledAgentIds(envMap['ALFRED_ENABLED_AGENTS'])
  const discordStateRaw = (envMap['DISCORD_STATE_DIR'] ?? '').trim()
  const discordStateDir = discordStateRaw || undefined

  let testReplyPrefix = ''
  if (mode === 'test') {
    const customPrefix = envMap['ALFRED_TEST_REPLY_PREFIX']
    testReplyPrefix = customPrefix && customPrefix.trim() ? customPrefix : DEFAULT_TEST_REPLY_PREFIX
  }

  return {
    mode,
    isTest: mode === 'test',
    isOps: mode === 'ops',
    dbPath,
    workspacesDir,
    budgetMultiplier,
    enabledAgentIds,
    testReplyPrefix,
    discordStateDir,
    discordPresence: buildDiscordPresence(mode),
  }
}
