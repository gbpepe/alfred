import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { readEnvFile } from '../env.js'
import { logger } from '../logger.js'
import type { AlfredCliProviderName } from './agents-config.js'
import {
  checkCliProvidersHealth,
  resolveCliBinary,
  sanitizeCliText,
  spawnCliProcess,
  type CliProcessRunner,
  type CliProviderHealthStatus,
  type CliSpawnResult,
} from './cli-runner.js'

export type ManagedCliId = 'claude' | 'codex' | 'gemini'

export interface ManagedCliDefinition {
  id: ManagedCliId
  provider: AlfredCliProviderName
  packageName: string
  binaryName: string
  configDirName: string
  configEnvVar: string
}

export const MANAGED_CLI_REGISTRY: Readonly<Record<ManagedCliId, ManagedCliDefinition>> = {
  claude: {
    id: 'claude',
    provider: 'claude-cli',
    packageName: '@anthropic-ai/claude-code',
    binaryName: 'claude',
    configDirName: '.claude',
    configEnvVar: 'CLAUDE_CONFIG_DIR',
  },
  codex: {
    id: 'codex',
    provider: 'codex-cli',
    packageName: '@openai/codex',
    binaryName: 'codex',
    configDirName: '.codex',
    configEnvVar: 'CODEX_HOME',
  },
  gemini: {
    id: 'gemini',
    provider: 'gemini-cli',
    packageName: '@google/gemini-cli',
    binaryName: 'gemini',
    configDirName: '.gemini',
    configEnvVar: 'GEMINI_CLI_HOME',
  },
}

export interface CliInventoryItem {
  id: ManagedCliId
  provider: AlfredCliProviderName
  packageName: string
  binary: string
  installed: boolean
  version?: string
  resolvedPath?: string
  authConfigured: boolean
  prefix: string
}

export interface CliManageResult {
  ok: true
  id: ManagedCliId
  provider: AlfredCliProviderName
  packageName: string
  action: 'install' | 'remove'
  prefix: string
  output: string
  purgedAuth?: boolean
  status?: CliInventoryItem
}

export class CliManagerValidationError extends Error {
  public readonly code = 'CLI_INVALID_PROVIDER' as const

  constructor(message: string) {
    super(message)
    this.name = 'CliManagerValidationError'
  }
}

const NPM_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'TMP',
  'TEMP',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'NPM_CONFIG_CACHE',
  'npm_config_cache',
  'NPM_CONFIG_REGISTRY',
  'SystemRoot',
  'COMSPEC',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
]

/**
 * Strictly normalizes a CLI identifier against the 3-item allowlist (`claude`, `codex`, `gemini`).
 */
export function normalizeManagedCliId(raw: string): ManagedCliId {
  const clean = String(raw ?? '').trim().toLowerCase()
  if (clean === 'claude' || clean === 'claude-cli') return 'claude'
  if (clean === 'codex' || clean === 'codex-cli') return 'codex'
  if (clean === 'gemini' || clean === 'gemini-cli') return 'gemini'
  throw new CliManagerValidationError(
    `CLI_INVALID_PROVIDER: Unsupported CLI "${raw}". Allowed: claude, codex, gemini`,
  )
}

export function getManagedCliDefinition(raw: string): ManagedCliDefinition {
  return MANAGED_CLI_REGISTRY[normalizeManagedCliId(raw)]
}

export function resolveCliNpmPrefix(env: Record<string, string | undefined>): string {
  const explicit = (env['ALFRED_CLI_PREFIX'] ?? env['NPM_CONFIG_PREFIX'] ?? '').trim()
  if (explicit) return explicit
  const home = (env['HOME'] ?? env['USERPROFILE'] ?? '').trim()
  return home ? join(home, '.local') : ''
}

export function resolveCliBinDir(prefix: string): string {
  if (!prefix) return ''
  return process.platform === 'win32' ? prefix : join(prefix, 'bin')
}

export function resolveCliBinPath(prefix: string, binaryName: string): string | undefined {
  if (!prefix) return undefined
  const dirs = [resolveCliBinDir(prefix), join(prefix, 'bin')]
  const names = process.platform === 'win32' ? [`${binaryName}.cmd`, `${binaryName}.exe`, binaryName] : [binaryName]
  for (const dir of dirs) {
    if (!dir) continue
    for (const name of names) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

function withCliPrefixPath(env: Record<string, string | undefined>, prefix: string): Record<string, string | undefined> {
  if (!prefix) return { ...env }
  const binDir = resolveCliBinDir(prefix)
  const existingPath = env['PATH'] ?? ''
  const parts = existingPath.split(delimiter).filter(Boolean)
  const extraDirs = [binDir, join(prefix, 'bin')].filter((d, idx, arr) => d && arr.indexOf(d) === idx && !parts.includes(d))
  return {
    ...env,
    PATH: [...extraDirs, ...parts].join(delimiter),
    NPM_CONFIG_PREFIX: prefix,
  }
}

function buildSanitizedNpmEnv(env: Record<string, string | undefined>, prefix: string): Record<string, string> {
  const enriched = withCliPrefixPath(env, prefix)
  const out: Record<string, string> = {}
  for (const key of NPM_ENV_ALLOWLIST) {
    const val = enriched[key]
    if (typeof val === 'string' && val.length > 0) {
      out[key] = val
    }
  }
  if (prefix) {
    out['NPM_CONFIG_PREFIX'] = prefix
    out['npm_config_prefix'] = prefix
  }
  const npmCacheDir = (enriched['npm_config_cache'] ?? enriched['NPM_CONFIG_CACHE'] ?? '').trim() || join(tmpdir(), 'alfred-npm-cache')
  const npmLogsDir = (enriched['npm_config_logs_dir'] ?? enriched['NPM_CONFIG_LOGS_DIR'] ?? '').trim() || join(tmpdir(), 'alfred-npm-logs')
  out['NPM_CONFIG_CACHE'] = npmCacheDir
  out['npm_config_cache'] = npmCacheDir
  out['NPM_CONFIG_LOGS_DIR'] = npmLogsDir
  out['npm_config_logs_dir'] = npmLogsDir
  return out
}

async function runNpmSubprocess(
  args: string[],
  prefix: string,
  envMap: Record<string, string | undefined>,
  timeoutMs: number,
  processRunner?: CliProcessRunner,
): Promise<CliSpawnResult> {
  const npmBin = envMap['ALFRED_NPM_BIN']?.trim() || 'npm'
  const childEnv = buildSanitizedNpmEnv(envMap, prefix)
  const cwd = prefix && existsSync(prefix) ? prefix : process.cwd()

  if (processRunner) {
    return processRunner({
      command: npmBin,
      args,
      cwd,
      env: childEnv,
      timeoutMs,
      killGraceMs: 5_000,
      maxOutputBytes: 2 * 1024 * 1024,
    })
  }

  if (process.platform === 'win32' && npmBin === 'npm') {
    const npmCliJs = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (existsSync(npmCliJs)) {
      return spawnCliProcess({
        command: process.execPath,
        args: [npmCliJs, ...args],
        cwd,
        env: childEnv,
        timeoutMs,
        killGraceMs: 5_000,
        maxOutputBytes: 2 * 1024 * 1024,
      })
    }
  }

  return spawnCliProcess({
    command: npmBin,
    args,
    cwd,
    env: childEnv,
    timeoutMs,
    killGraceMs: 5_000,
    maxOutputBytes: 2 * 1024 * 1024,
  })
}

function toInventoryItem(
  def: ManagedCliDefinition,
  health: CliProviderHealthStatus | undefined,
  prefix: string,
  env: Record<string, string | undefined>,
): CliInventoryItem {
  const resolved = resolveCliBinPath(prefix, def.binaryName) ?? (health?.installed ? resolveCliBinary(def.provider, env) : undefined)
  return {
    id: def.id,
    provider: def.provider,
    packageName: def.packageName,
    binary: health?.binary ?? resolveCliBinary(def.provider, env),
    installed: Boolean(health?.installed),
    ...(health?.version ? { version: health.version } : {}),
    ...(resolved ? { resolvedPath: resolved } : {}),
    authConfigured: Boolean(health?.authConfigured),
    prefix,
  }
}

/**
 * Returns inventory + health/auth status for all 3 managed CLIs (`claude`, `codex`, `gemini`).
 */
export async function getCliInventory(opts?: {
  env?: Record<string, string | undefined>
  processRunner?: CliProcessRunner
  timeoutMs?: number
}): Promise<CliInventoryItem[]> {
  const envMap = opts?.env ?? { ...readEnvFile(), ...process.env }
  const prefix = resolveCliNpmPrefix(envMap)
  const enrichedEnv = withCliPrefixPath(envMap, prefix)
  const healthList = await checkCliProvidersHealth({
    env: enrichedEnv,
    processRunner: opts?.processRunner,
    timeoutMs: opts?.timeoutMs ?? 5_000,
  })

  return (['claude', 'codex', 'gemini'] as ManagedCliId[]).map((id) => {
    const def = MANAGED_CLI_REGISTRY[id]
    const health = healthList.find((h) => h.provider === def.provider)
    return toInventoryItem(def, health, prefix, enrichedEnv)
  })
}

/**
 * Installs or updates one allowlisted CLI into the user-level prefix (`NPM_CONFIG_PREFIX`, default `~/.local`)
 * without sudo or shell interpolation.
 */
export async function installOrUpdateCli(
  rawProvider: string,
  opts?: {
    env?: Record<string, string | undefined>
    processRunner?: CliProcessRunner
    timeoutMs?: number
  },
): Promise<CliManageResult> {
  const def = getManagedCliDefinition(rawProvider)
  const envMap = opts?.env ?? { ...readEnvFile(), ...process.env }
  const prefix = resolveCliNpmPrefix(envMap)
  if (prefix) {
    if (!existsSync(prefix)) {
      mkdirSync(prefix, { recursive: true })
    }
    const binDir = resolveCliBinDir(prefix)
    if (binDir && !existsSync(binDir)) {
      mkdirSync(binDir, { recursive: true })
    }
  }

  const res = await runNpmSubprocess(
    ['install', '-g', `${def.packageName}@latest`],
    prefix,
    envMap,
    opts?.timeoutMs ?? 180_000,
    opts?.processRunner,
  )

  const combinedOutput = sanitizeCliText([res.stdout, res.stderr].filter(Boolean).join('\n')).trim()
  if (res.spawnErrorCode || res.timedOut || res.exitCode !== 0) {
    logger.warn({ cli: def.id, exitCode: res.exitCode, timedOut: res.timedOut }, 'CLI install/update failed')
    throw new Error(`Failed to install/update ${def.packageName}: ${combinedOutput || `exit ${res.exitCode}`}`)
  }

  const inventory = await getCliInventory({ env: envMap, processRunner: opts?.processRunner, timeoutMs: 5_000 })
  const status = inventory.find((i) => i.id === def.id)

  return {
    ok: true,
    id: def.id,
    provider: def.provider,
    packageName: def.packageName,
    action: 'install',
    prefix,
    output: combinedOutput.slice(0, 1500),
    ...(status ? { status } : {}),
  }
}

/**
 * Uninstalls an allowlisted CLI package from the user-level prefix.
 * Preserves local auth/config directories unless `options.purgeAuth === true`.
 */
export async function removeCli(
  rawProvider: string,
  opts?: {
    purgeAuth?: boolean
    env?: Record<string, string | undefined>
    processRunner?: CliProcessRunner
    timeoutMs?: number
  },
): Promise<CliManageResult> {
  const def = getManagedCliDefinition(rawProvider)
  const envMap = opts?.env ?? { ...readEnvFile(), ...process.env }
  const prefix = resolveCliNpmPrefix(envMap)

  const res = await runNpmSubprocess(
    ['uninstall', '-g', def.packageName],
    prefix,
    envMap,
    opts?.timeoutMs ?? 120_000,
    opts?.processRunner,
  )

  const combinedOutput = sanitizeCliText([res.stdout, res.stderr].filter(Boolean).join('\n')).trim()
  if (res.spawnErrorCode || res.timedOut || res.exitCode !== 0) {
    logger.warn({ cli: def.id, exitCode: res.exitCode, timedOut: res.timedOut }, 'CLI remove failed')
    throw new Error(`Failed to remove ${def.packageName}: ${combinedOutput || `exit ${res.exitCode}`}`)
  }

  let purgedAuth = false
  if (opts?.purgeAuth === true) {
    const home = (envMap['HOME'] ?? envMap['USERPROFILE'] ?? '').trim()
    const authDir = (envMap[def.configEnvVar] ?? '').trim() || (home ? join(home, def.configDirName) : '')
    if (authDir && existsSync(authDir)) {
      rmSync(authDir, { recursive: true, force: true })
      purgedAuth = true
    }
  }

  return {
    ok: true,
    id: def.id,
    provider: def.provider,
    packageName: def.packageName,
    action: 'remove',
    prefix,
    purgedAuth,
    output: combinedOutput.slice(0, 1500),
  }
}
