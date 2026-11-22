import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { assertEnvEntry, ENV_FILE_MODE, isSingleLineEnvValue, readEnvFile } from '../env.js'
import { logger } from '../logger.js'
import { atomicWriteFileSync } from '../web/atomic-write.js'
import type { AlfredCliProviderName } from './agents-config.js'
import {
  checkCliProvidersHealth,
  resolveCliBinary,
  sanitizeCliText,
  spawnCliProcess,
  type CliAuthMethod,
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
  authMethod: CliAuthMethod
  authDetail?: string
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
    authMethod: health?.authMethod ?? 'none',
    ...(health?.authDetail ? { authDetail: health.authDetail } : {}),
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

// ---------------------------------------------------------------------------
// SSH-free CLI credentials (token / OAuth JSON) & logout
// ---------------------------------------------------------------------------

const PRIMARY_OAUTH_FILES: Readonly<Record<ManagedCliId, string>> = {
  claude: '.credentials.json',
  codex: 'auth.json',
  gemini: 'oauth_creds.json',
}

const ALL_OAUTH_FILES: Readonly<Record<ManagedCliId, readonly string[]>> = {
  claude: ['.credentials.json', 'credentials.json'],
  codex: ['auth.json', 'credentials.json'],
  gemini: ['oauth_creds.json', 'google_accounts.json'],
}

export function resolveCliAuthDir(
  def: ManagedCliDefinition,
  env: Record<string, string | undefined>,
): string {
  const explicit = (env[def.configEnvVar] ?? '').trim()
  if (explicit) return explicit
  const home = (env['HOME'] ?? env['USERPROFILE'] ?? '').trim()
  return home ? join(home, def.configDirName) : ''
}

function updateEnvFileAt(envPath: string, updates: Record<string, string | null>): void {
  const entries = Object.entries(updates)
  if (entries.length === 0) return
  for (const [key, val] of entries) {
    if (val !== null) {
      assertEnvEntry(key, val)
    } else {
      assertEnvEntry(key, 'x')
    }
  }

  let content = ''
  try {
    content = readFileSync(envPath, 'utf-8')
  } catch {
    content = ''
  }

  const remaining = new Map<string, string | null>(entries)
  const lines = content.length > 0 ? content.split('\n') : []
  const out: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      out.push(line)
      continue
    }
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) {
      out.push(line)
      continue
    }
    const key = trimmed.slice(0, eqIdx).trim()
    if (!remaining.has(key)) {
      out.push(line)
      continue
    }
    const val = remaining.get(key)
    remaining.delete(key)
    if (val !== null) {
      out.push(`${key}=${val}`)
    }
    // If val === null, omit the line to remove the key from .env
  }

  for (const [key, val] of remaining) {
    if (val !== null) {
      out.push(`${key}=${val}`)
    }
  }

  let mode = ENV_FILE_MODE
  try {
    mode = statSync(envPath).mode & 0o777
  } catch {
    /* file may not exist yet */
  }
  const parent = dirname(envPath)
  if (parent && !existsSync(parent)) {
    mkdirSync(parent, { recursive: true })
  }
  atomicWriteFileSync(envPath, out.join('\n'), { mode })
}

export interface SaveCliCredentialsResult {
  ok: true
  id: ManagedCliId
  provider: AlfredCliProviderName
  savedKind: 'oauth_json' | 'env_token'
  target: string
  status?: CliInventoryItem
}

/**
 * Saves CLI authentication credentials (either an OAuth credentials JSON file or a token/API key)
 * without requiring SSH access. Secrets are never logged or returned.
 */
export async function saveCliCredentials(
  rawProvider: string,
  input: { token?: string; authJson?: string },
  opts?: {
    env?: Record<string, string | undefined>
    envFilePath?: string
    updateProcessEnv?: boolean
    processRunner?: CliProcessRunner
  },
): Promise<SaveCliCredentialsResult> {
  const def = getManagedCliDefinition(rawProvider)
  const envMap: Record<string, string | undefined> = opts?.env
    ? { ...opts.env }
    : { ...readEnvFile(), ...process.env }
  const envFilePath = opts?.envFilePath ?? join(process.env['ALFRED_ENV_DIR'] ?? process.cwd(), '.env')
  const shouldMutateProcessEnv = opts?.updateProcessEnv ?? !opts?.env

  const rawJson = typeof input.authJson === 'string' ? input.authJson.trim() : ''
  const rawToken = typeof input.token === 'string' ? input.token.trim() : ''

  if (!rawJson && !rawToken) {
    throw new CliManagerValidationError('Adj meg egy tokent vagy OAuth JSON tartalmat.')
  }

  let savedKind: 'oauth_json' | 'env_token'
  let target: string

  if (rawJson) {
    let parsed: unknown
    try {
      parsed = JSON.parse(rawJson)
    } catch {
      throw new CliManagerValidationError('Érvénytelen JSON formátum az OAuth hitelesítési adatokban.')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new CliManagerValidationError('Az OAuth JSON gyökérelemének objektumnak ({...}) kell lennie.')
    }
    const authDir = resolveCliAuthDir(def, envMap)
    if (!authDir) {
      throw new Error(`Nem határozható meg a ${def.id} konfigurációs könyvtára (HOME nincs beállítva).`)
    }
    if (!existsSync(authDir)) {
      mkdirSync(authDir, { recursive: true, mode: 0o700 })
    }
    const filePath = join(authDir, PRIMARY_OAUTH_FILES[def.id])
    atomicWriteFileSync(filePath, JSON.stringify(parsed, null, 2) + '\n', { mode: 0o600 })
    savedKind = 'oauth_json'
    target = PRIMARY_OAUTH_FILES[def.id]
    logger.info({ cli: def.id, target }, 'Saved CLI OAuth JSON credentials')
  } else {
    if (!isSingleLineEnvValue(rawToken)) {
      throw new CliManagerValidationError('A token nem tartalmazhat sortörést vagy vezérlőkaraktert.')
    }
    let envKey: string
    if (def.id === 'claude') {
      envKey = rawToken.startsWith('sk-ant-oat') ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'ANTHROPIC_API_KEY'
    } else if (def.id === 'codex') {
      envKey = 'OPENAI_API_KEY'
    } else {
      envKey = 'GEMINI_API_KEY'
    }
    updateEnvFileAt(envFilePath, { [envKey]: rawToken })
    envMap[envKey] = rawToken
    if (shouldMutateProcessEnv) {
      process.env[envKey] = rawToken
    }
    savedKind = 'env_token'
    target = envKey
    logger.info({ cli: def.id, envKey }, 'Saved CLI token to .env')
  }

  const inventory = await getCliInventory({ env: envMap, processRunner: opts?.processRunner, timeoutMs: 5_000 })
  const status = inventory.find((i) => i.id === def.id)
  return {
    ok: true,
    id: def.id,
    provider: def.provider,
    savedKind,
    target,
    ...(status ? { status } : {}),
  }
}

export interface LogoutCliResult {
  ok: true
  id: ManagedCliId
  provider: AlfredCliProviderName
  removedFiles: string[]
  clearedEnvKeys: string[]
  status?: CliInventoryItem
}

/**
 * Removes OAuth credential files (and CLAUDE_CODE_OAUTH_TOKEN for Claude) without uninstalling the CLI binary.
 */
export async function logoutCli(
  rawProvider: string,
  opts?: {
    env?: Record<string, string | undefined>
    envFilePath?: string
    updateProcessEnv?: boolean
    processRunner?: CliProcessRunner
  },
): Promise<LogoutCliResult> {
  const def = getManagedCliDefinition(rawProvider)
  const envMap: Record<string, string | undefined> = opts?.env
    ? { ...opts.env }
    : { ...readEnvFile(), ...process.env }
  const envFilePath = opts?.envFilePath ?? join(process.env['ALFRED_ENV_DIR'] ?? process.cwd(), '.env')
  const shouldMutateProcessEnv = opts?.updateProcessEnv ?? !opts?.env

  const removedFiles: string[] = []
  const clearedEnvKeys: string[] = []

  const authDir = resolveCliAuthDir(def, envMap)
  if (authDir) {
    for (const fname of ALL_OAUTH_FILES[def.id]) {
      const candidate = join(authDir, fname)
      if (existsSync(candidate)) {
        rmSync(candidate, { force: true })
        removedFiles.push(fname)
      }
    }
  }

  if (def.id === 'claude' && (envMap['CLAUDE_CODE_OAUTH_TOKEN'] || '').trim()) {
    try {
      if (existsSync(envFilePath)) {
        updateEnvFileAt(envFilePath, { CLAUDE_CODE_OAUTH_TOKEN: null })
      }
    } catch {
      /* ignore if .env is absent */
    }
    delete envMap['CLAUDE_CODE_OAUTH_TOKEN']
    if (shouldMutateProcessEnv) {
      delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
    }
    clearedEnvKeys.push('CLAUDE_CODE_OAUTH_TOKEN')
  }

  logger.info({ cli: def.id, removedFiles, clearedEnvKeys }, 'Logged out CLI OAuth credentials')
  const inventory = await getCliInventory({ env: envMap, processRunner: opts?.processRunner, timeoutMs: 5_000 })
  const status = inventory.find((i) => i.id === def.id)
  return {
    ok: true,
    id: def.id,
    provider: def.provider,
    removedFiles,
    clearedEnvKeys,
    ...(status ? { status } : {}),
  }
}

// ---------------------------------------------------------------------------
// Interactive Browser / Device OAuth Login Sessions (SSH-free from Dashboard)
// ---------------------------------------------------------------------------

export type CliLoginPhase =
  | 'starting'
  | 'waiting_auth'
  | 'submitting'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export interface CliLoginStatusSnapshot {
  active: boolean
  id: ManagedCliId
  provider: AlfredCliProviderName
  phase: CliLoginPhase
  authUrl?: string
  deviceCode?: string
  needsCodeInput: boolean
  message?: string
  error?: string
  outputTail?: string
  startedAt: number
}

interface ActiveCliLoginSession {
  id: ManagedCliId
  provider: AlfredCliProviderName
  phase: CliLoginPhase
  authUrl?: string
  deviceCode?: string
  needsCodeInput: boolean
  message?: string
  error?: string
  outputTail?: string
  startedAt: number
  child: ChildProcess | null
  timer: NodeJS.Timeout | null
  watchTimer: NodeJS.Timeout | null
  tempRoot: string | null
  browserUrlFile: string | null
  oauthWatchFile: string | null
  oauthBaselineMtimeMs: number
  autoEnterCount: number
  lastAutoEnterAt: number
  rawBuffer: string
  envFilePath?: string
  updateProcessEnv?: boolean
}

const activeCliLoginSessions = new Map<ManagedCliId, ActiveCliLoginSession>()
const CLI_LOGIN_TIMEOUT_MS = 5 * 60 * 1000

/* eslint-disable no-control-regex */
const ANSI_OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
const ANSI_CSI_RE = /\x1b\[[0-9;?<>=]*[A-Za-z]/g
const ANSI_MISC_RE = /\x1b[=>]?/g
const ANSI_OSC8_RE = /\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]+)(?:\x07|\x1b\\)/g
/* eslint-enable no-control-regex */

const ALLOWED_OAUTH_HOST_PATTERNS: Readonly<Record<ManagedCliId, RegExp>> = {
  claude: /^(?:[a-z0-9-]+\.)*(?:claude\.ai|claude\.com|anthropic\.com)$/i,
  codex: /^(?:[a-z0-9-]+\.)*(?:openai\.com|chatgpt\.com)$/i,
  gemini: /^(?:[a-z0-9-]+\.)*(?:google\.com|googleapis\.com)$/i,
}

const PYTHON_PTY_RELAY = [
  'import errno,fcntl,os,pty,select,signal,struct,sys,termios,time',
  'cmd=sys.argv[1:]',
  'pid,master=pty.fork()',
  'if pid==0:',
  '  try: fcntl.ioctl(0,termios.TIOCSWINSZ,struct.pack("HHHH",24,512,0,0))',
  '  except OSError: pass',
  '  try: os.execvp(cmd[0],cmd)',
  '  except OSError: os._exit(127)',
  'stop=[False]',
  'def h(*_): stop[0]=True',
  'signal.signal(signal.SIGTERM,h); signal.signal(signal.SIGHUP,h)',
  'while not stop[0]:',
  '  try: r,_,_=select.select([master,0],[],[],0.5)',
  '  except InterruptedError: continue',
  '  if master in r:',
  '    try: d=os.read(master,65536)',
  '    except OSError: d=b""',
  '    if not d: break',
  '    os.write(1,d)',
  '  if 0 in r:',
  '    d=os.read(0,4096)',
  '    if not d: break',
  '    os.write(master,d)',
  'try: os.close(master)',
  'except OSError: pass',
  'end=time.time()+3.0; st=None',
  'while time.time()<end:',
  '  done,st=os.waitpid(pid,os.WNOHANG)',
  '  if done: break',
  '  time.sleep(0.05)',
  'else:',
  '  try: os.kill(pid,signal.SIGKILL)',
  '  except OSError: pass',
  '  _,st=os.waitpid(pid,0)',
  'sys.exit(os.WEXITSTATUS(st) if st is not None and os.WIFEXITED(st) else 1)',
].join('\n')

function stripAnsi(raw: string): string {
  return raw.replace(ANSI_OSC_RE, '').replace(ANSI_CSI_RE, '').replace(ANSI_MISC_RE, '')
}

function isAllowedLoginUrl(id: ManagedCliId, urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr)
    if (parsed.protocol !== 'https:') return false
    return ALLOWED_OAUTH_HOST_PATTERNS[id].test(parsed.hostname)
  } catch {
    return false
  }
}

export function extractCliLoginUrl(id: ManagedCliId, raw: string): string | null {
  for (const m of raw.matchAll(ANSI_OSC8_RE)) {
    const candidate = m[1]?.trim()
    if (candidate && isAllowedLoginUrl(id, candidate)) return candidate
  }
  const clean = stripAnsi(raw)
  const matches = clean.match(/https:\/\/[^\s"'<>)\]]+/g) ?? []
  for (const rawUrl of matches) {
    const candidate = rawUrl.replace(/[.,;:]+$/, '')
    if (isAllowedLoginUrl(id, candidate)) {
      if (id === 'claude' && !candidate.includes('oauth')) continue
      if (id === 'gemini' && !candidate.includes('oauth') && !candidate.includes('auth')) continue
      return candidate
    }
  }
  return null
}

export function extractCodexDeviceCode(raw: string): string | null {
  const clean = stripAnsi(raw)
  const m = /\b([A-Z0-9]{4,5}-[A-Z0-9]{4,5})\b/.exec(clean)
  return m?.[1] ?? null
}

function extractClaudeOAuthToken(raw: string): string | null {
  const clean = stripAnsi(raw)
  const m = /(sk-ant-oat01-[A-Za-z0-9_-]{40,})/.exec(clean)
  return m?.[1] ?? null
}

function buildSanitizedOutputTail(raw: string): string | undefined {
  const clean = sanitizeCliText(stripAnsi(raw))
    .replace(/sk-ant-oat01-[A-Za-z0-9_-]+/g, 'sk-ant-oat01-[REDACTED]')
    .replace(/ya29\.[A-Za-z0-9._-]+/g, '[REDACTED_TOKEN]')
    .replace(/\r/g, '\n')
  const lines = clean
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^[╭╮╰╯│─━┌┐└┘├┤┬┴┼▀▄█░▒▓\s]+$/.test(l))
  if (lines.length === 0) return undefined
  return lines.slice(-6).join('\n').slice(0, 600)
}

function toLoginSnapshot(s: ActiveCliLoginSession): CliLoginStatusSnapshot {
  const active = s.phase === 'starting' || s.phase === 'waiting_auth' || s.phase === 'submitting'
  return {
    active,
    id: s.id,
    provider: s.provider,
    phase: s.phase,
    ...(s.authUrl ? { authUrl: s.authUrl } : {}),
    ...(s.deviceCode ? { deviceCode: s.deviceCode } : {}),
    needsCodeInput: s.needsCodeInput,
    ...(s.message ? { message: s.message } : {}),
    ...(s.error ? { error: s.error } : {}),
    ...(s.outputTail ? { outputTail: s.outputTail } : {}),
    startedAt: s.startedAt,
  }
}

function cleanupLoginSessionResources(session: ActiveCliLoginSession): void {
  if (session.timer) {
    clearTimeout(session.timer)
    session.timer = null
  }
  if (session.watchTimer) {
    clearInterval(session.watchTimer)
    session.watchTimer = null
  }
  if (session.child) {
    try {
      session.child.stdin?.end()
    } catch {
      /* ignore */
    }
    try {
      session.child.kill('SIGTERM')
    } catch {
      /* ignore */
    }
    session.child = null
  }
  if (session.tempRoot) {
    try {
      rmSync(session.tempRoot, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
    session.tempRoot = null
  }
  session.browserUrlFile = null
  session.rawBuffer = ''
}

function ensureGeminiOAuthSettings(authDir: string): void {
  if (!authDir) return
  try {
    if (!existsSync(authDir)) {
      mkdirSync(authDir, { recursive: true, mode: 0o700 })
    }
    const settingsPath = join(authDir, 'settings.json')
    let existing: Record<string, unknown> = {}
    if (existsSync(settingsPath)) {
      try {
        const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8')) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          existing = parsed as Record<string, unknown>
        }
      } catch {
        existing = {}
      }
    }
    const sec = (existing['security'] && typeof existing['security'] === 'object' && !Array.isArray(existing['security'])
      ? { ...(existing['security'] as Record<string, unknown>) }
      : {}) as Record<string, unknown>
    const auth = (sec['auth'] && typeof sec['auth'] === 'object' && !Array.isArray(sec['auth'])
      ? { ...(sec['auth'] as Record<string, unknown>) }
      : {}) as Record<string, unknown>
    auth['selectedType'] = 'oauth-personal'
    sec['auth'] = auth
    existing['security'] = sec
    existing['selectedAuthType'] = 'oauth-personal'
    atomicWriteFileSync(settingsPath, JSON.stringify(existing, null, 2) + '\n', { mode: 0o600 })
  } catch {
    /* best effort */
  }
}

function buildLoginChildEnv(
  def: ManagedCliDefinition,
  envMap: Record<string, string | undefined>,
  prefix: string,
  tempRoot: string,
  browserUrlFile: string,
): Record<string, string> {
  const enriched = withCliPrefixPath(envMap, prefix)
  const out: Record<string, string> = {}
  const allow = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'LANG',
    'LC_ALL',
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
    'SystemRoot',
    'COMSPEC',
    'APPDATA',
    'LOCALAPPDATA',
    'USERPROFILE',
  ]
  for (const key of allow) {
    const val = enriched[key]
    if (typeof val === 'string' && val.length > 0) out[key] = val
  }
  out['TERM'] = 'xterm-256color'
  out['NO_BROWSER'] = 'true'

  if (process.platform !== 'win32') {
    const noBrowserScript = join(tempRoot, 'no-browser.sh')
    const escapedOut = browserUrlFile.replace(/'/g, "'\\''")
    writeFileSync(
      noBrowserScript,
      `#!/bin/sh\nprintf '%s\\n' "$1" >> '${escapedOut}'\nprintf '\\n%s\\n' "$1"\nexit 0\n`,
      { mode: 0o700 },
    )
    out['BROWSER'] = noBrowserScript
  }

  if (def.id === 'claude') {
    const cfgDir = join(tempRoot, 'claude-config')
    mkdirSync(cfgDir, { recursive: true, mode: 0o700 })
    out['CLAUDE_CONFIG_DIR'] = cfgDir
  } else if (def.id === 'codex' && enriched['CODEX_HOME']?.trim()) {
    out['CODEX_HOME'] = enriched['CODEX_HOME'].trim()
  } else if (def.id === 'gemini' && enriched['GEMINI_CLI_HOME']?.trim()) {
    out['GEMINI_CLI_HOME'] = enriched['GEMINI_CLI_HOME'].trim()
  }

  return out
}

function checkLoginSideChannels(session: ActiveCliLoginSession): void {
  if (session.phase === 'succeeded' || session.phase === 'cancelled' || session.phase === 'failed') return

  if (!session.authUrl && session.browserUrlFile && existsSync(session.browserUrlFile)) {
    try {
      const content = readFileSync(session.browserUrlFile, 'utf-8')
      const url = extractCliLoginUrl(session.id, content)
      if (url) {
        session.authUrl = url
        session.phase = 'waiting_auth'
        session.message =
          session.id === 'codex'
            ? 'Nyisd meg a linket a böngészőben és írd be a lent látható kódot.'
            : 'Nyisd meg a linket a böngészőben, majd másold vissza ide a kapott kódot.'
      }
    } catch {
      /* ignore */
    }
  }

  if ((session.id === 'gemini' || session.id === 'codex') && session.oauthWatchFile && existsSync(session.oauthWatchFile)) {
    try {
      const st = statSync(session.oauthWatchFile)
      if (st.size > 2 && st.mtimeMs > session.oauthBaselineMtimeMs) {
        session.phase = 'succeeded'
        session.message = `${session.provider} OAuth előfizetés sikeresen mentve!`
        cleanupLoginSessionResources(session)
      }
    } catch {
      /* ignore */
    }
  }
}

/**
 * Starts an interactive browser/device OAuth login session for `claude`, `codex`, or `gemini`.
 */
export async function startCliLogin(
  rawProvider: string,
  opts?: {
    env?: Record<string, string | undefined>
    envFilePath?: string
    updateProcessEnv?: boolean
  },
): Promise<CliLoginStatusSnapshot> {
  const def = getManagedCliDefinition(rawProvider)
  const existing = activeCliLoginSessions.get(def.id)
  if (existing && (existing.phase === 'starting' || existing.phase === 'waiting_auth' || existing.phase === 'submitting')) {
    cleanupLoginSessionResources(existing)
  }

  const envMap = opts?.env ?? { ...readEnvFile(), ...process.env }
  const prefix = resolveCliNpmPrefix(envMap)
  const binPath = resolveCliBinPath(prefix, def.binaryName) ?? resolveCliBinary(def.provider, envMap)
  const authDir = resolveCliAuthDir(def, envMap)

  if (def.id === 'gemini' && authDir) {
    ensureGeminiOAuthSettings(authDir)
  }

  const tempRoot = mkdtempSync(join(tmpdir(), `alfred-cli-login-${def.id}-`))
  const browserUrlFile = join(tempRoot, 'browser-url.txt')
  const childEnv = buildLoginChildEnv(def, envMap, prefix, tempRoot, browserUrlFile)

  const oauthWatchFile =
    (def.id === 'gemini' || def.id === 'codex') && authDir
      ? join(authDir, PRIMARY_OAUTH_FILES[def.id])
      : null
  let oauthBaselineMtimeMs = 0
  if (oauthWatchFile && existsSync(oauthWatchFile)) {
    try {
      oauthBaselineMtimeMs = statSync(oauthWatchFile).mtimeMs
    } catch {
      oauthBaselineMtimeMs = 0
    }
  }

  const cliArgs =
    def.id === 'claude'
      ? ['setup-token']
      : def.id === 'codex'
        ? ['login', '--device-auth']
        : []

  const session: ActiveCliLoginSession = {
    id: def.id,
    provider: def.provider,
    phase: 'starting',
    needsCodeInput: def.id !== 'codex',
    message: 'Bejelentkezési folyamat indítása...',
    startedAt: Date.now(),
    child: null,
    timer: null,
    watchTimer: null,
    tempRoot,
    browserUrlFile,
    oauthWatchFile,
    oauthBaselineMtimeMs,
    autoEnterCount: 0,
    lastAutoEnterAt: 0,
    rawBuffer: '',
    envFilePath: opts?.envFilePath,
    updateProcessEnv: opts?.updateProcessEnv,
  }
  activeCliLoginSessions.set(def.id, session)

  const usePythonPty = process.platform === 'linux' && existsSync('/usr/bin/python3')
  const spawnCmd = usePythonPty ? '/usr/bin/python3' : binPath
  const spawnArgs = usePythonPty ? ['-u', '-c', PYTHON_PTY_RELAY, binPath, ...cliArgs] : cliArgs

  const child = spawn(spawnCmd, spawnArgs, {
    cwd: tempRoot,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  })
  session.child = child

  session.timer = setTimeout(() => {
    if (session.phase === 'starting' || session.phase === 'waiting_auth' || session.phase === 'submitting') {
      session.phase = 'failed'
      session.error = 'Időtúllépés (5 perc): a bejelentkezés nem fejeződött be időben.'
      cleanupLoginSessionResources(session)
    }
  }, CLI_LOGIN_TIMEOUT_MS)

  session.watchTimer = setInterval(() => {
    checkLoginSideChannels(session)
  }, 800)

  const handleChunk = (chunk: Buffer | string) => {
    if (session.phase === 'succeeded' || session.phase === 'cancelled' || session.phase === 'failed') return
    session.rawBuffer += chunk.toString('utf-8')
    if (session.rawBuffer.length > 64_000) {
      session.rawBuffer = session.rawBuffer.slice(-32_000)
    }
    session.outputTail = buildSanitizedOutputTail(session.rawBuffer)

    if (!session.authUrl) {
      const url = extractCliLoginUrl(def.id, session.rawBuffer)
      if (url) {
        session.authUrl = url
        session.phase = 'waiting_auth'
        session.message =
          def.id === 'codex'
            ? 'Nyisd meg a linket a böngészőben és írd be a lent látható kódot.'
            : 'Nyisd meg a linket a böngészőben, majd másold vissza ide a kapott kódot.'
      } else if (def.id === 'gemini' && session.autoEnterCount < 4) {
        const tailLower = (session.outputTail ?? '').toLowerCase()
        const looksLikePrompt =
          tailLower.includes('login with google') ||
          tailLower.includes('get started') ||
          tailLower.includes('choose a theme') ||
          tailLower.includes('trust') ||
          tailLower.includes('press enter') ||
          tailLower.includes('use enter to select')
        const now = Date.now()
        if (looksLikePrompt && now - session.lastAutoEnterAt >= 1200) {
          session.autoEnterCount += 1
          session.lastAutoEnterAt = now
          try {
            session.child?.stdin?.write('\r')
          } catch {
            /* ignore */
          }
        }
      }
    }

    if (def.id === 'codex' && !session.deviceCode) {
      const code = extractCodexDeviceCode(session.rawBuffer)
      if (code) {
        session.deviceCode = code
        if (session.phase === 'starting') {
          session.phase = 'waiting_auth'
        }
      }
    }

    if (def.id === 'claude') {
      const token = extractClaudeOAuthToken(session.rawBuffer)
      if (token) {
        session.rawBuffer = ''
        void saveCliCredentials(
          'claude',
          { token },
          {
            envFilePath: session.envFilePath,
            updateProcessEnv: session.updateProcessEnv,
          },
        )
          .then(() => {
            session.phase = 'succeeded'
            session.message = 'Claude OAuth előfizetés sikeresen mentve!'
            cleanupLoginSessionResources(session)
          })
          .catch((err) => {
            session.phase = 'failed'
            session.error = err instanceof Error ? err.message : String(err)
            cleanupLoginSessionResources(session)
          })
      }
    }

    checkLoginSideChannels(session)
  }

  child.stdout?.on('data', handleChunk)
  child.stderr?.on('data', handleChunk)

  child.on('error', (err) => {
    if (session.phase === 'succeeded' || session.phase === 'cancelled') return
    session.phase = 'failed'
    session.error = `Nem sikerült elindítani a CLI-t: ${err.message}`
    cleanupLoginSessionResources(session)
  })

  child.on('exit', (code) => {
    if (session.phase === 'succeeded' || session.phase === 'cancelled') return
    if (code === 0 && (def.id === 'codex' || def.id === 'gemini')) {
      session.phase = 'succeeded'
      session.message = `${def.provider} OAuth bejelentkezés sikeres!`
    } else if (def.id === 'claude') {
      session.phase = 'failed'
      session.error = 'A claude setup-token folyamat token nélkül leállt. Próbáld újra vagy add meg kézzel a tokent.'
    } else {
      session.phase = 'failed'
      session.error = `A bejelentkezési folyamat hibával leállt (exit=${code ?? 'signal'}).`
    }
    cleanupLoginSessionResources(session)
  })

  // Wait briefly (up to 3.5s) so authUrl / deviceCode is often ready on the initial response
  const waitStart = Date.now()
  while (
    Date.now() - waitStart < 3500 &&
    session.phase === 'starting' &&
    !session.authUrl
  ) {
    await new Promise((r) => setTimeout(r, 150))
  }

  return toLoginSnapshot(session)
}

export function getCliLoginStatus(rawProvider: string): CliLoginStatusSnapshot {
  const def = getManagedCliDefinition(rawProvider)
  const session = activeCliLoginSessions.get(def.id)
  if (!session) {
    return {
      active: false,
      id: def.id,
      provider: def.provider,
      phase: 'cancelled',
      needsCodeInput: def.id !== 'codex',
      startedAt: 0,
    }
  }
  checkLoginSideChannels(session)
  return toLoginSnapshot(session)
}

export function parseSubmittedLoginInput(
  id: ManagedCliId,
  rawInput: string,
): { ptyCode: string; localCallbackUrl?: string } {
  const trimmed = String(rawInput ?? '').trim()
  if (!trimmed || /[\r\n\0\x1b]/.test(trimmed) || trimmed.length > 4096) {
    throw new CliManagerValidationError('Érvénytelen bejelentkezési kód vagy callback URL.')
  }

  // Support pasting the full http://localhost:<port>/callback?code=...&state=... URL directly
  const looksLikeLocalUrl = /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1):\d+\//i.test(trimmed)
  if (looksLikeLocalUrl) {
    const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
    let parsed: URL
    try {
      parsed = new URL(withProto)
    } catch {
      throw new CliManagerValidationError('Érvénytelen localhost callback URL.')
    }
    const portNum = Number(parsed.port)
    if (
      parsed.protocol !== 'http:' ||
      (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') ||
      !Number.isInteger(portNum) ||
      portNum < 1024 ||
      portNum > 65535
    ) {
      throw new CliManagerValidationError('Csak helyi (localhost/127.0.0.1) callback URL fogadható el.')
    }
    const localCallbackUrl = `http://127.0.0.1:${portNum}${parsed.pathname}${parsed.search}`
    const codeParam = parsed.searchParams.get('code')?.trim() ?? ''
    const stateParam = parsed.searchParams.get('state')?.trim() ?? ''
    const ptyCode =
      id === 'claude' && codeParam && stateParam
        ? `${codeParam}#${stateParam}`
        : codeParam || trimmed
    return { ptyCode, localCallbackUrl }
  }

  return { ptyCode: trimmed }
}

export function submitCliLoginCode(rawProvider: string, rawCode: string): CliLoginStatusSnapshot {
  const def = getManagedCliDefinition(rawProvider)
  const session = activeCliLoginSessions.get(def.id)
  if (!session || !session.child || (session.phase !== 'waiting_auth' && session.phase !== 'starting' && session.phase !== 'submitting')) {
    throw new CliManagerValidationError('Nincs aktív, kódra váró bejelentkezési folyamat.')
  }
  const { ptyCode, localCallbackUrl } = parseSubmittedLoginInput(def.id, rawCode)
  session.phase = 'submitting'
  session.message = localCallbackUrl
    ? 'Callback továbbítása a helyi CLI szervernek és token ellenőrzése...'
    : 'Kód feldolgozása és token ellenőrzése...'

  const sendToPty = () => {
    if (!session.child || session.phase !== 'submitting') return
    try {
      session.child.stdin?.write(ptyCode)
      // Ink / raw PTY prompts (Claude CLI 2.1+) treat an Enter arriving in the same burst as pasted text;
      // send CR (\r) after 500ms so the prompt actually submits.
      setTimeout(() => {
        if (session.child && session.phase === 'submitting') {
          try {
            session.child.stdin?.write('\r')
          } catch {
            /* ignore */
          }
        }
      }, 500)
    } catch {
      /* ignore */
    }
  }

  if (localCallbackUrl) {
    // Relay the localhost callback directly inside the VPS to the CLI's local listener;
    // if the listener is not open (or fails), fall back to pasting code#state into the PTY.
    void fetch(localCallbackUrl, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(8_000),
    })
      .then((resp) => {
        if (!resp.ok && resp.status >= 400) {
          sendToPty()
        }
      })
      .catch(() => {
        sendToPty()
      })
  } else {
    sendToPty()
  }

  return toLoginSnapshot(session)
}

export function cancelCliLogin(rawProvider: string): CliLoginStatusSnapshot {
  const def = getManagedCliDefinition(rawProvider)
  const session = activeCliLoginSessions.get(def.id)
  if (session) {
    session.phase = 'cancelled'
    session.message = 'Bejelentkezés megszakítva.'
    cleanupLoginSessionResources(session)
    return toLoginSnapshot(session)
  }
  return getCliLoginStatus(def.id)
}
