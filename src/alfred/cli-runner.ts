import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { readEnvFile } from '../env.js'
import { logger } from '../logger.js'
import type { AlfredAgentDefinition, AlfredCliProviderName } from './agents-config.js'
import type { ChatMessage, ProviderUsageMetrics } from './model-router.js'
import { mapWhitelistToClaudePermissions, matchProtectedPath, ProtectedPathError } from './tool-executor.js'

export type CliErrorKind =
  | 'AUTH_REQUIRED'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'BINARY_NOT_FOUND'
  | 'NON_ZERO_EXIT'
  | 'PARSE_ERROR'

export interface CliQueueStats {
  active: number
  queued: number
  maxConcurrency: number
}

export interface CliSpawnRequest {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  timeoutMs: number
  killGraceMs: number
  maxOutputBytes: number
}

export interface CliSpawnResult {
  stdout: string
  stderr: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  spawnErrorCode?: string
}

export type CliProcessRunner = (req: CliSpawnRequest) => Promise<CliSpawnResult>
export type CliGitRunner = (args: string[], cwd: string) => string

export interface CliRunResult {
  content: string
  model: string
  usage: ProviderUsageMetrics
  rawOutput?: string
}

export interface RunCliAgentOptions {
  agent: AlfredAgentDefinition
  userMessage: string
  conversationHistory?: readonly ChatMessage[]
  env?: Record<string, string | undefined>
  processRunner?: CliProcessRunner
  gitRunner?: CliGitRunner
  queue?: CliExecutionQueue
  onQueued?: (position: number) => void
  killGraceMs?: number
  maxOutputBytes?: number
}

export type RunCliAgentFn = (opts: RunCliAgentOptions) => Promise<CliRunResult>

export type CliAuthMethod = 'oauth' | 'api_key' | 'none'

export interface CliProviderHealthStatus {
  provider: AlfredCliProviderName
  binary: string
  installed: boolean
  version?: string
  authConfigured: boolean
  authMethod: CliAuthMethod
  authDetail?: string
}

const DEFAULT_CLI_TIMEOUT_MS = 300_000
const DEFAULT_KILL_GRACE_MS = 5_000
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024
const DEFAULT_MAX_PROMPT_CHARS = 32_000
const MAX_SNAPSHOT_FILE_BYTES = 1024 * 1024
const MAX_SNAPSHOT_DIR_FILES = 500

const BASE_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TZ',
  'TMPDIR',
  'TMP',
  'TEMP',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  // Windows runtime essentials
  'SystemRoot',
  'COMSPEC',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
]

const PROVIDER_ENV_ALLOWLIST: Record<AlfredCliProviderName, readonly string[]> = {
  'claude-cli': ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_BASE_URL'],
  'codex-cli': ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'CODEX_HOME'],
  'gemini-cli': [
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_CLOUD_PROJECT',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GEMINI_CLI_HOME',
  ],
  'agy-cli': [
    'AGY_ADC_AUTH',
    'AGY_CONFIG_DIR',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_CLOUD_PROJECT',
    'GOOGLE_APPLICATION_CREDENTIALS',
  ],
}

const PROVIDER_CONFIG_DIR_VAR: Record<AlfredCliProviderName, string> = {
  'claude-cli': 'CLAUDE_CONFIG_DIR',
  'codex-cli': 'CODEX_HOME',
  'gemini-cli': 'GEMINI_CLI_HOME',
  'agy-cli': 'AGY_CONFIG_DIR',
}

const PROVIDER_BIN_ENV: Record<AlfredCliProviderName, { envKey: string; defaultBin: string }> = {
  'claude-cli': { envKey: 'ALFRED_CLAUDE_BIN', defaultBin: 'claude' },
  'codex-cli': { envKey: 'ALFRED_CODEX_BIN', defaultBin: 'codex' },
  'gemini-cli': { envKey: 'ALFRED_GEMINI_BIN', defaultBin: 'gemini' },
  'agy-cli': { envKey: 'ALFRED_AGY_BIN', defaultBin: 'agy' },
}

const WRITE_TOOLS = new Set(['fs_write', 'bash', 'git'])

/**
 * Redacts API keys, OAuth tokens, Bearer/Bot headers, and GCP tokens from CLI text before logging or replying.
 */
export function sanitizeCliText(raw: string): string {
  if (!raw) return ''
  return raw
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?<>=]*[A-Za-z]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-[REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/Bot\s+[A-Za-z0-9._-]+/g, 'Bot [REDACTED]')
    .replace(/ya29\.[A-Za-z0-9._-]+/g, '[REDACTED_TOKEN]')
    .replace(/AIza[A-Za-z0-9_-]{10,}/g, 'AIza[REDACTED]')
}

export function classifyCliError(
  _provider: AlfredCliProviderName,
  exitCode: number | null,
  stderr: string,
  timedOut: boolean,
  spawnErrorCode?: string,
): CliErrorKind {
  if (spawnErrorCode === 'ENOENT') return 'BINARY_NOT_FOUND'
  if (timedOut) return 'TIMEOUT'

  const clean = stderr.toLowerCase()
  if (
    /not logged in|login required|please log in|unauthorized|\b401\b|authentication (?:failed|required|error)|invalid api key|expired token|credentials? (?:not found|missing|expired)/.test(
      clean,
    )
  ) {
    return 'AUTH_REQUIRED'
  }
  if (
    /rate[\s_-]?limit|\b429\b|quota (?:exceeded|exhausted)|too many requests|credit balance|insufficient_quota|usage limit/.test(
      clean,
    )
  ) {
    return 'RATE_LIMITED'
  }
  if (exitCode !== 0) {
    return 'NON_ZERO_EXIT'
  }
  return 'NON_ZERO_EXIT'
}

export function formatCliDiscordError(
  provider: AlfredCliProviderName,
  kind: CliErrorKind,
  sanitizedDetail: string,
): string {
  const detailSnippet = sanitizedDetail.trim().slice(0, 260)
  const suffix = detailSnippet ? `\nRészlet: \`${detailSnippet}\`` : ''

  switch (kind) {
    case 'AUTH_REQUIRED': {
      const loginHint =
        provider === 'claude-cli'
          ? 'sudo -u alfred claude login'
          : provider === 'codex-cli'
            ? 'sudo -u alfred codex login'
            : 'sudo -u alfred gemini'
      return (
        `🔐 **CLI_EXECUTION_FAILED** (\`${provider}\`): Hitelesítés szükséges vagy lejárt a munkamenet. ` +
        `Futtasd a VPS-en: \`${loginHint}\`.${suffix}`
      )
    }
    case 'RATE_LIMITED':
      return `⏳ **CLI_EXECUTION_FAILED** (\`${provider}\`): A szolgáltató kvótája / rate limitje kimerült.${suffix}`
    case 'TIMEOUT':
      return `⏱️ **CLI_EXECUTION_FAILED** (\`${provider}\`): A CLI folyamat túllépte az időkorlátot és le lett állítva.${suffix}`
    case 'BINARY_NOT_FOUND':
      return `⚠️ **CLI_EXECUTION_FAILED** (\`${provider}\`): A CLI bináris nem található a PATH-ban.${suffix}`
    case 'PARSE_ERROR':
      return `⚠️ **CLI_EXECUTION_FAILED** (\`${provider}\`): A CLI kimenete nem érvényes JSON/JSONL formátumú.${suffix}`
    case 'NON_ZERO_EXIT':
    default:
      return `⚠️ **CLI_EXECUTION_FAILED** (\`${provider}\`): A CLI folyamat hibával lépett ki.${suffix}`
  }
}

export class CliExecutionError extends Error {
  public readonly code = 'CLI_EXECUTION_FAILED' as const
  public readonly provider: AlfredCliProviderName
  public readonly kind: CliErrorKind
  public readonly exitCode: number | null
  public readonly stderr: string
  public readonly discordMessage: string

  constructor(params: {
    provider: AlfredCliProviderName
    kind: CliErrorKind
    exitCode: number | null
    stderr?: string
    message?: string
  }) {
    const safeStderr = sanitizeCliText(params.stderr ?? '')
    const discordMessage = formatCliDiscordError(params.provider, params.kind, params.message || safeStderr)
    super(sanitizeCliText(params.message ?? discordMessage))
    this.name = 'CliExecutionError'
    this.provider = params.provider
    this.kind = params.kind
    this.exitCode = params.exitCode
    this.stderr = safeStderr
    this.discordMessage = discordMessage
  }
}

/**
 * Async FIFO execution queue / mutex to bound concurrent CLI child processes (default 1 on 2 GB RAM VPS).
 */
export class CliExecutionQueue {
  private readonly maxConcurrency: number
  private active = 0
  private waiters: Array<() => void> = []

  constructor(maxConcurrency = 1) {
    this.maxConcurrency = Number.isFinite(maxConcurrency) && maxConcurrency >= 1 ? Math.floor(maxConcurrency) : 1
  }

  public getStats(): CliQueueStats {
    return {
      active: this.active,
      queued: this.waiters.length,
      maxConcurrency: this.maxConcurrency,
    }
  }

  private acquire(onQueued?: (position: number) => void): Promise<void> {
    if (this.active < this.maxConcurrency) {
      this.active += 1
      return Promise.resolve()
    }
    const position = this.waiters.length + 1
    onQueued?.(position)
    return new Promise<void>((resolveAcquire) => {
      this.waiters.push(() => {
        this.active += 1
        resolveAcquire()
      })
    })
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1)
    if (this.active < this.maxConcurrency && this.waiters.length > 0) {
      const next = this.waiters.shift()!
      next()
    }
  }

  public async runExclusive<T>(fn: () => Promise<T>, opts?: { onQueued?: (position: number) => void }): Promise<T> {
    await this.acquire(opts?.onQueued)
    try {
      return await fn()
    } finally {
      this.release()
    }
  }
}

let defaultCliQueue: CliExecutionQueue | null = null

export function parseCliMaxConcurrency(env: Record<string, string | undefined>): number {
  const raw = env['ALFRED_CLI_MAX_CONCURRENCY']
  if (!raw || !raw.trim()) return 1
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 ? n : 1
}

export function getDefaultCliQueue(env?: Record<string, string | undefined>): CliExecutionQueue {
  const effectiveEnv = env ?? process.env
  const desired = parseCliMaxConcurrency(effectiveEnv)
  if (!defaultCliQueue) {
    defaultCliQueue = new CliExecutionQueue(desired)
  } else {
    const stats = defaultCliQueue.getStats()
    if (
      env?.['ALFRED_CLI_MAX_CONCURRENCY'] !== undefined &&
      stats.active === 0 &&
      stats.queued === 0 &&
      stats.maxConcurrency !== desired
    ) {
      defaultCliQueue = new CliExecutionQueue(desired)
    }
  }
  return defaultCliQueue
}

export function getCliQueueStats(): CliQueueStats {
  return getDefaultCliQueue().getStats()
}

export function resetDefaultCliQueue(): void {
  defaultCliQueue = null
}

/**
 * Allowlist-only environment builder: isolates child CLI processes from Discord/other-provider secrets.
 */
export function buildSanitizedCliEnv(
  provider: AlfredCliProviderName,
  sourceEnv: Record<string, string | undefined>,
  cliConfigDir?: string,
): Record<string, string> {
  const out: Record<string, string> = {}

  for (const key of BASE_ENV_ALLOWLIST) {
    const val = sourceEnv[key]
    if (typeof val === 'string' && val.length > 0) {
      out[key] = val
    }
  }

  for (const key of PROVIDER_ENV_ALLOWLIST[provider]) {
    const val = sourceEnv[key]
    if (typeof val === 'string' && val.length > 0) {
      out[key] = val
    }
  }

  if (cliConfigDir && cliConfigDir.trim()) {
    out[PROVIDER_CONFIG_DIR_VAR[provider]] = cliConfigDir.trim()
  }

  // If OAuth subscription auth is active, strip paid API keys from the CLI subprocess
  // so the CLI always uses the subscription quota instead of pay-per-token billing.
  const auth = detectCliAuthStatus(provider, { ...sourceEnv, ...out })
  if (auth.method === 'oauth') {
    if (provider === 'claude-cli') {
      delete out['ANTHROPIC_API_KEY']
    } else if (provider === 'codex-cli') {
      delete out['OPENAI_API_KEY']
      delete out['CODEX_API_KEY']
    } else if (provider === 'gemini-cli' || provider === 'agy-cli') {
      delete out['GEMINI_API_KEY']
      delete out['GOOGLE_API_KEY']
      delete out['GOOGLE_APPLICATION_CREDENTIALS']
    }
  }

  // Gemini CLI 0.70+ requires GEMINI_CLI_TRUST_WORKSPACE=true in headless non-interactive mode.
  if (provider === 'gemini-cli') {
    out['GEMINI_CLI_TRUST_WORKSPACE'] = 'true'
  }

  return out
}

export function resolveCliBinary(provider: AlfredCliProviderName, env: Record<string, string | undefined>): string {
  const spec = PROVIDER_BIN_ENV[provider]
  const override = env[spec.envKey]?.trim()
  return override || spec.defaultBin
}

export function resolveCliTimeoutMs(
  agent: Pick<AlfredAgentDefinition, 'cliTimeoutMs'>,
  env: Record<string, string | undefined>,
): number {
  if (typeof agent.cliTimeoutMs === 'number' && Number.isFinite(agent.cliTimeoutMs) && agent.cliTimeoutMs >= 1_000) {
    return Math.floor(agent.cliTimeoutMs)
  }
  const raw = env['ALFRED_CLI_TIMEOUT_MS']
  if (raw && raw.trim()) {
    const parsed = Number(raw)
    if (Number.isFinite(parsed) && parsed >= 1_000) {
      return Math.floor(parsed)
    }
  }
  return DEFAULT_CLI_TIMEOUT_MS
}

function resolveMaxPromptChars(env: Record<string, string | undefined>): number {
  const raw = env['ALFRED_CLI_MAX_PROMPT_CHARS']
  if (raw && raw.trim()) {
    const parsed = Number(raw)
    if (Number.isFinite(parsed) && parsed >= 500) {
      return Math.floor(parsed)
    }
  }
  return DEFAULT_MAX_PROMPT_CHARS
}

function formatPromptsWithBudget(
  systemPrompt: string,
  history: readonly ChatMessage[],
  userMessage: string,
  maxChars: number,
): { userPromptWithHistory: string; combinedPrompt: string } {
  const cleanSys = systemPrompt.trim()
  const cleanUser = userMessage.trim()
  const turns = history
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim().length > 0)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.trim()}`)

  const build = (activeTurns: string[]) => {
    const userPromptWithHistory =
      activeTurns.length > 0
        ? `## Korábbi beszélgetés\n${activeTurns.join('\n')}\n\n## Aktuális kérés\n${cleanUser}`
        : cleanUser
    const combinedPrompt = cleanSys
      ? `## Rendszerutasítás\n${cleanSys}\n\n${userPromptWithHistory}`
      : userPromptWithHistory
    return { userPromptWithHistory, combinedPrompt }
  }

  let built = build(turns)
  while (turns.length > 0 && built.combinedPrompt.length > maxChars) {
    turns.shift()
    built = build(turns)
  }
  return built
}

export interface CliCommandSpec {
  command: string
  args: string[]
  promptText: string
}

/**
 * Builds shell-less argv specifications for `claude-cli`, `codex-cli`, and `gemini-cli`.
 */
export function buildCliCommandSpec(params: {
  agent: AlfredAgentDefinition
  userMessage: string
  conversationHistory?: readonly ChatMessage[]
  env: Record<string, string | undefined>
}): CliCommandSpec {
  const provider = params.agent.provider as AlfredCliProviderName
  const command = resolveCliBinary(provider, params.env)
  const maxChars = resolveMaxPromptChars(params.env)
  const systemPrompt = params.agent.resolvedSystemPrompt?.trim() ?? ''
  const { userPromptWithHistory, combinedPrompt } = formatPromptsWithBudget(
    systemPrompt,
    params.conversationHistory ?? [],
    params.userMessage,
    maxChars,
  )

  const hasWriteTools = params.agent.tools.some((t) => WRITE_TOOLS.has(t))
  const model = params.agent.model?.trim() ?? 'default'
  const hasExplicitModel = Boolean(model && model !== 'default')

  if (provider === 'claude-cli') {
    const args: string[] = ['-p', userPromptWithHistory, '--output-format', 'json']
    if (systemPrompt) {
      args.push('--append-system-prompt', systemPrompt)
    }
    if (hasExplicitModel) {
      args.push('--model', model)
    }
    const perms = mapWhitelistToClaudePermissions(params.agent.tools, params.agent.workspaceAbsPath, {
      protectedPaths: params.agent.protectedPaths,
      allowedBashCommands: params.agent.allowedBashCommands,
    })
    if (perms.allow.length > 0) {
      args.push('--allowedTools', perms.allow.join(','))
    }
    if (perms.deny.length > 0) {
      args.push('--disallowedTools', perms.deny.join(','))
    }
    return { command, args, promptText: combinedPrompt }
  }

  if (provider === 'codex-cli') {
    const args: string[] = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--sandbox',
      hasWriteTools ? 'workspace-write' : 'read-only',
    ]
    if (hasExplicitModel) {
      args.push('-m', model)
    }
    args.push(combinedPrompt)
    return { command, args, promptText: combinedPrompt }
  }

  if (provider === 'agy-cli') {
    const args: string[] = ['-p', combinedPrompt, '--output-format', 'json', '--disable-slash-commands']
    if (hasExplicitModel) {
      args.push('--model', model)
    }
    args.push('--mode', hasWriteTools ? 'accept-edits' : 'plan')
    return { command, args, promptText: combinedPrompt }
  }

  // gemini-cli
  const args: string[] = ['-p', combinedPrompt, '--output-format', 'json']
  if (hasExplicitModel) {
    args.push('-m', model)
  }
  if (hasWriteTools) {
    args.push('--approval-mode', 'auto_edit')
  }
  return { command, args, promptText: combinedPrompt }
}

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && typeof child.pid === 'number' && child.pid > 0) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // fall back to direct kill
    }
  }
  try {
    child.kill(signal)
  } catch {
    // ignore if already exited
  }
}

/**
 * Default shell-less subprocess runner with bounded output buffers and process-group timeout termination.
 */
export async function spawnCliProcess(req: CliSpawnRequest): Promise<CliSpawnResult> {
  return new Promise<CliSpawnResult>((resolveSpawn) => {
    const child = spawn(req.command, req.args, {
      cwd: req.cwd,
      env: req.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let stdoutTruncated = false
    let stderrTruncated = false
    let timedOut = false
    let spawnErrorCode: string | undefined
    let settled = false
    let graceTimer: ReturnType<typeof setTimeout> | undefined

    const appendBounded = (
      chunk: Buffer,
      target: Buffer[],
      currentBytes: number,
      alreadyTruncated: boolean,
    ): { bytes: number; truncated: boolean } => {
      if (alreadyTruncated) return { bytes: currentBytes, truncated: true }
      const remaining = req.maxOutputBytes - currentBytes
      if (remaining <= 0) {
        target.push(Buffer.from('\n[TRUNCATED]', 'utf-8'))
        return { bytes: currentBytes, truncated: true }
      }
      if (chunk.length > remaining) {
        target.push(chunk.subarray(0, remaining), Buffer.from('\n[TRUNCATED]', 'utf-8'))
        return { bytes: req.maxOutputBytes, truncated: true }
      }
      target.push(chunk)
      return { bytes: currentBytes + chunk.length, truncated: false }
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      const next = appendBounded(chunk, stdoutChunks, stdoutBytes, stdoutTruncated)
      stdoutBytes = next.bytes
      stdoutTruncated = next.truncated
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      const next = appendBounded(chunk, stderrChunks, stderrBytes, stderrTruncated)
      stderrBytes = next.bytes
      stderrTruncated = next.truncated
    })

    const timeoutTimer = setTimeout(() => {
      timedOut = true
      killProcessTree(child, 'SIGTERM')
      graceTimer = setTimeout(() => {
        killProcessTree(child, 'SIGKILL')
      }, req.killGraceMs)
      graceTimer.unref?.()
    }, req.timeoutMs)
    timeoutTimer.unref?.()

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      if (graceTimer) clearTimeout(graceTimer)
      resolveSpawn({
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
        exitCode,
        signal,
        timedOut,
        ...(spawnErrorCode ? { spawnErrorCode } : {}),
      })
    }

    child.on('error', (err: NodeJS.ErrnoException) => {
      spawnErrorCode = err.code ?? 'SPAWN_ERROR'
      const msg = err.message || 'Failed to spawn CLI process'
      if (stderrBytes === 0) {
        stderrChunks.push(Buffer.from(msg, 'utf-8'))
      }
      finish(null, null)
    })

    child.on('close', (code, signal) => {
      finish(code, signal)
    })
  })
}

function estimateTokens(text: string): number {
  return text ? Math.ceil(text.length / 4) : 0
}

function canonicalCliModel(
  provider: AlfredCliProviderName,
  reportedModel: string | undefined,
  configuredModel: string,
): string {
  const chosen = (reportedModel && reportedModel.trim()) || (configuredModel && configuredModel.trim()) || 'default'
  if (chosen.startsWith(`${provider}:`)) return chosen
  return `${provider}:${chosen}`
}

function extractJsonObject(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // try scanning lines from bottom or last {...} block
  }

  const lines = trimmed.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line.startsWith('{')) continue
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // continue
    }
  }

  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      const parsed = JSON.parse(trimmed.slice(firstBrace, lastBrace + 1))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      return null
    }
  }

  return null
}

function withFallbackTokenEstimate(
  usage: ProviderUsageMetrics,
  promptText: string,
  replyText: string,
): ProviderUsageMetrics {
  const total = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens
  if (total > 0) return usage
  return {
    inputTokens: estimateTokens(promptText),
    outputTokens: estimateTokens(replyText),
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    thinkingTokens: 0,
  }
}

function parseClaudeCliOutput(
  stdout: string,
  configuredModel: string,
  promptText: string,
): CliRunResult {
  const obj = extractJsonObject(stdout)
  if (!obj) {
    throw new CliExecutionError({
      provider: 'claude-cli',
      kind: 'PARSE_ERROR',
      exitCode: 0,
      message: 'Failed to parse Claude CLI JSON output',
    })
  }

  if (obj.is_error === true) {
    const errText = typeof obj.result === 'string' ? obj.result : 'Claude CLI reported an error'
    const kind = classifyCliError('claude-cli', 1, errText, false)
    throw new CliExecutionError({
      provider: 'claude-cli',
      kind,
      exitCode: 1,
      stderr: errText,
    })
  }

  const content =
    typeof obj.result === 'string'
      ? obj.result
      : typeof obj.text === 'string'
        ? obj.text
        : ''

  let reportedModel = typeof obj.model === 'string' ? obj.model : undefined
  const usage: ProviderUsageMetrics = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    thinkingTokens: 0,
  }

  if (obj.usage && typeof obj.usage === 'object' && !Array.isArray(obj.usage)) {
    const u = obj.usage as Record<string, unknown>
    usage.inputTokens = Number(u.input_tokens ?? u.inputTokens ?? 0) || 0
    usage.outputTokens = Number(u.output_tokens ?? u.outputTokens ?? 0) || 0
    usage.cacheReadTokens = Number(u.cache_read_input_tokens ?? u.cacheReadInputTokens ?? 0) || 0
    usage.cacheCreationTokens = Number(u.cache_creation_input_tokens ?? u.cacheCreationInputTokens ?? 0) || 0
  } else if (obj.modelUsage && typeof obj.modelUsage === 'object' && !Array.isArray(obj.modelUsage)) {
    for (const [mName, rawStats] of Object.entries(obj.modelUsage as Record<string, unknown>)) {
      if (!reportedModel) reportedModel = mName
      if (!rawStats || typeof rawStats !== 'object') continue
      const s = rawStats as Record<string, unknown>
      usage.inputTokens += Number(s.inputTokens ?? s.input_tokens ?? 0) || 0
      usage.outputTokens += Number(s.outputTokens ?? s.output_tokens ?? 0) || 0
      usage.cacheReadTokens += Number(s.cacheReadInputTokens ?? s.cache_read_input_tokens ?? 0) || 0
      usage.cacheCreationTokens += Number(s.cacheCreationInputTokens ?? s.cache_creation_input_tokens ?? 0) || 0
    }
  }

  return {
    content,
    model: canonicalCliModel('claude-cli', reportedModel, configuredModel),
    usage: withFallbackTokenEstimate(usage, promptText, content),
    rawOutput: stdout,
  }
}

function extractTextFromCodexContent(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) {
    return raw
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string') {
          return String((part as Record<string, unknown>).text)
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function parseCodexCliOutput(
  stdout: string,
  configuredModel: string,
  promptText: string,
): CliRunResult {
  const lines = stdout.split(/\r?\n/)
  let parsedCount = 0
  let lastAssistantMessage = ''
  let lastErrorText = ''
  let reportedModel: string | undefined
  const usage: ProviderUsageMetrics = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    thinkingTokens: 0,
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line.startsWith('{')) continue
    let ev: Record<string, unknown>
    try {
      const parsed = JSON.parse(line)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      ev = parsed as Record<string, unknown>
      parsedCount += 1
    } catch {
      continue
    }

    if (typeof ev.model === 'string' && ev.model.trim()) {
      reportedModel = ev.model.trim()
    }

    if (ev.type === 'item.completed' && ev.item && typeof ev.item === 'object') {
      const item = ev.item as Record<string, unknown>
      if (item.type === 'agent_message' || item.role === 'assistant') {
        const text = typeof item.text === 'string' ? item.text : extractTextFromCodexContent(item.content)
        if (text) lastAssistantMessage = text
      }
    } else if (ev.role === 'assistant' || (ev.type === 'message' && ev.role !== 'user')) {
      const text = typeof ev.text === 'string' ? ev.text : extractTextFromCodexContent(ev.content)
      if (text) lastAssistantMessage = text
    } else if (ev.type === 'response.output_text.done' && typeof ev.text === 'string') {
      lastAssistantMessage = ev.text
    }

    if (ev.type === 'turn.completed' && ev.usage && typeof ev.usage === 'object') {
      const u = ev.usage as Record<string, unknown>
      const rawInput = Number(u.input_tokens ?? 0) || 0
      const cached = Number(u.cached_input_tokens ?? 0) || 0
      usage.inputTokens += Math.max(0, rawInput - cached)
      usage.cacheReadTokens += cached
      usage.outputTokens += Number(u.output_tokens ?? 0) || 0
    }

    if (ev.type === 'error' && typeof ev.message === 'string') {
      lastErrorText = ev.message
    }
  }

  if (parsedCount === 0) {
    throw new CliExecutionError({
      provider: 'codex-cli',
      kind: 'PARSE_ERROR',
      exitCode: 0,
      message: 'Failed to parse Codex CLI JSONL output',
    })
  }

  if (!lastAssistantMessage && lastErrorText) {
    throw new CliExecutionError({
      provider: 'codex-cli',
      kind: classifyCliError('codex-cli', 1, lastErrorText, false),
      exitCode: 1,
      stderr: lastErrorText,
    })
  }

  return {
    content: lastAssistantMessage,
    model: canonicalCliModel('codex-cli', reportedModel, configuredModel),
    usage: withFallbackTokenEstimate(usage, promptText, lastAssistantMessage),
    rawOutput: stdout,
  }
}

function parseGeminiCliOutput(
  stdout: string,
  configuredModel: string,
  promptText: string,
): CliRunResult {
  const obj = extractJsonObject(stdout)
  if (!obj) {
    throw new CliExecutionError({
      provider: 'gemini-cli',
      kind: 'PARSE_ERROR',
      exitCode: 0,
      message: 'Failed to parse Gemini CLI JSON output',
    })
  }

  const content =
    typeof obj.response === 'string'
      ? obj.response
      : typeof obj.text === 'string'
        ? obj.text
        : ''

  let reportedModel: string | undefined
  const usage: ProviderUsageMetrics = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    thinkingTokens: 0,
  }

  const stats = obj.stats as Record<string, unknown> | undefined
  const models = stats?.models as Record<string, unknown> | undefined
  if (models && typeof models === 'object' && !Array.isArray(models)) {
    for (const [mName, entry] of Object.entries(models)) {
      if (!reportedModel) reportedModel = mName
      if (!entry || typeof entry !== 'object') continue
      const tokens = (entry as Record<string, unknown>).tokens as Record<string, unknown> | undefined
      if (!tokens || typeof tokens !== 'object') continue
      const prompt = Number(tokens.prompt ?? tokens.input ?? 0) || 0
      const cached = Number(tokens.cached ?? 0) || 0
      const thoughts = Number(tokens.thoughts ?? 0) || 0
      const candidates = Number(tokens.candidates ?? tokens.output ?? 0) || 0
      usage.inputTokens += Math.max(0, prompt - cached)
      usage.cacheReadTokens += cached
      usage.thinkingTokens += thoughts
      usage.outputTokens += candidates + thoughts
    }
  }

  return {
    content,
    model: canonicalCliModel('gemini-cli', reportedModel, configuredModel),
    usage: withFallbackTokenEstimate(usage, promptText, content),
    rawOutput: stdout,
  }
}

function parseAgyCliOutput(
  stdout: string,
  configuredModel: string,
  promptText: string,
): CliRunResult {
  const obj = extractJsonObject(stdout)
  if (!obj) {
    const plain = sanitizeCliText(stdout).trim()
    return {
      content: plain,
      model: canonicalCliModel('agy-cli', undefined, configuredModel),
      usage: withFallbackTokenEstimate(
        { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0 },
        promptText,
        plain,
      ),
      rawOutput: stdout,
    }
  }

  const content =
    typeof obj.result === 'string'
      ? obj.result
      : typeof obj.response === 'string'
        ? obj.response
        : typeof obj.text === 'string'
          ? obj.text
          : typeof obj.content === 'string'
            ? obj.content
            : ''

  const reportedModel = typeof obj.model === 'string' ? obj.model : undefined
  const u = (obj.usage ?? {}) as Record<string, unknown>
  const usage: ProviderUsageMetrics = {
    inputTokens: Number(u.input_tokens ?? u.inputTokens ?? u.prompt_tokens ?? 0) || 0,
    outputTokens: Number(u.output_tokens ?? u.outputTokens ?? u.completion_tokens ?? 0) || 0,
    cacheReadTokens: Number(u.cache_read_input_tokens ?? u.cacheReadTokens ?? 0) || 0,
    cacheCreationTokens: Number(u.cache_creation_input_tokens ?? u.cacheCreationTokens ?? 0) || 0,
    thinkingTokens: Number(u.thinking_tokens ?? u.thinkingTokens ?? 0) || 0,
  }

  return {
    content,
    model: canonicalCliModel('agy-cli', reportedModel, configuredModel),
    usage: withFallbackTokenEstimate(usage, promptText, content),
    rawOutput: stdout,
  }
}

export function parseCliOutput(
  provider: AlfredCliProviderName,
  stdout: string,
  configuredModel: string,
  promptText: string,
): CliRunResult {
  if (provider === 'claude-cli') return parseClaudeCliOutput(stdout, configuredModel, promptText)
  if (provider === 'codex-cli') return parseCodexCliOutput(stdout, configuredModel, promptText)
  if (provider === 'agy-cli') return parseAgyCliOutput(stdout, configuredModel, promptText)
  return parseGeminiCliOutput(stdout, configuredModel, promptText)
}

function defaultGitRunner(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: 10_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function normalizeRelPosix(p: string): string {
  return p.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/^\/+/, '').replace(/\/+$/, '')
}

function unquoteGitPath(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  return trimmed
}

function parseGitStatusPorcelain(output: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const line of output.split(/\r?\n/)) {
    if (!line || line.length < 4) continue
    const xy = line.slice(0, 2)
    const rest = line.slice(3)
    if ((xy.includes('R') || xy.includes('C')) && rest.includes(' -> ')) {
      const [fromPath, toPath] = rest.split(' -> ')
      if (fromPath) map.set(normalizeRelPosix(unquoteGitPath(fromPath)), xy)
      if (toPath) map.set(normalizeRelPosix(unquoteGitPath(toPath)), xy)
    } else {
      map.set(normalizeRelPosix(unquoteGitPath(rest)), xy)
    }
  }
  return map
}

interface FileSnapshotEntry {
  relPath: string
  absPath: string
  rule: string
  sha256: string
  backupContent?: Buffer
}

interface ProtectedSnapshot {
  wsReal: string
  isGitRepo: boolean
  gitStatusBefore: Map<string, string>
  fileSnapshots: Map<string, FileSnapshotEntry>
  nonExistentTargets: Array<{ relPath: string; absPath: string; rule: string }>
  existingDirFiles: Map<string, { absDir: string; rule: string; files: Set<string> }>
}

function sha256Buffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

function isTransientSqliteSidecar(relPath: string): boolean {
  return /\.(?:db|sqlite|sqlite3)-(?:wal|shm|journal)$/i.test(relPath)
}

function collectFilesInDir(
  rootAbs: string,
  currentAbs: string,
  wsReal: string,
  out: Array<{ relPath: string; absPath: string }>,
): void {
  if (out.length >= MAX_SNAPSHOT_DIR_FILES) return
  let entries
  try {
    entries = readdirSync(currentAbs, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (out.length >= MAX_SNAPSHOT_DIR_FILES) break
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    const childAbs = join(currentAbs, entry.name)
    if (entry.isDirectory()) {
      collectFilesInDir(rootAbs, childAbs, wsReal, out)
    } else if (entry.isFile()) {
      out.push({
        relPath: normalizeRelPosix(relative(wsReal, childAbs)),
        absPath: childAbs,
      })
    }
  }
}

function captureProtectedSnapshot(
  agent: Pick<AlfredAgentDefinition, 'workspaceAbsPath' | 'protectedPaths'>,
  gitRunner: CliGitRunner,
): ProtectedSnapshot | null {
  const rules = agent.protectedPaths
  if (!rules || rules.length === 0) return null

  mkdirSync(agent.workspaceAbsPath, { recursive: true })
  const wsReal = realpathSync(agent.workspaceAbsPath)

  let isGitRepo = false
  let gitStatusBefore = new Map<string, string>()
  try {
    const statusOut = gitRunner(['status', '--porcelain', '-uall'], wsReal)
    isGitRepo = true
    gitStatusBefore = parseGitStatusPorcelain(statusOut)
  } catch {
    isGitRepo = false
  }

  const fileSnapshots = new Map<string, FileSnapshotEntry>()
  const nonExistentTargets: Array<{ relPath: string; absPath: string; rule: string }> = []
  const existingDirFiles = new Map<string, { absDir: string; rule: string; files: Set<string> }>()

  const snapshotFile = (relPath: string, absPath: string, rule: string) => {
    if (fileSnapshots.has(relPath) || isTransientSqliteSidecar(relPath)) return
    try {
      const st = statSync(absPath)
      if (!st.isFile()) return
      if (st.size <= MAX_SNAPSHOT_FILE_BYTES) {
        const buf = readFileSync(absPath)
        fileSnapshots.set(relPath, {
          relPath,
          absPath,
          rule,
          sha256: sha256Buffer(buf),
          backupContent: buf,
        })
      }
    } catch {
      // ignore unreadable
    }
  }

  for (const rule of rules) {
    const clean = normalizeRelPosix(rule)
    if (!clean) continue
    const absTarget = resolve(wsReal, clean)
    const relCheck = relative(wsReal, absTarget)
    if (relCheck.startsWith('..') || isAbsolute(relCheck)) continue

    if (!existsSync(absTarget)) {
      nonExistentTargets.push({ relPath: clean, absPath: absTarget, rule })
      continue
    }

    try {
      const st = statSync(absTarget)
      if (st.isFile()) {
        snapshotFile(clean, absTarget, rule)
      } else if (st.isDirectory()) {
        const dirFiles: Array<{ relPath: string; absPath: string }> = []
        collectFilesInDir(absTarget, absTarget, wsReal, dirFiles)
        const fileSet = new Set<string>()
        for (const f of dirFiles) {
          fileSet.add(f.relPath)
          snapshotFile(f.relPath, f.absPath, rule)
        }
        existingDirFiles.set(clean, { absDir: absTarget, rule, files: fileSet })
      }
    } catch {
      // ignore stat errors
    }
  }

  return {
    wsReal,
    isGitRepo,
    gitStatusBefore,
    fileSnapshots,
    nonExistentTargets,
    existingDirFiles,
  }
}

function verifyAndRevertProtectedPaths(
  agent: Pick<AlfredAgentDefinition, 'id' | 'workspaceAbsPath' | 'protectedPaths'>,
  snapshot: ProtectedSnapshot | null,
  gitRunner: CliGitRunner,
): void {
  if (!snapshot || !agent.protectedPaths || agent.protectedPaths.length === 0) return

  const violations: Array<{ relPath: string; rule: string }> = []

  // 1. Git porcelain diff verification (catches tracked edits, staged changes, renames, untracked additions)
  if (snapshot.isGitRepo) {
    let gitStatusAfter = new Map<string, string>()
    try {
      const statusOut = gitRunner(['status', '--porcelain', '-uall'], snapshot.wsReal)
      gitStatusAfter = parseGitStatusPorcelain(statusOut)
    } catch {
      // fall through to filesystem hash checks
    }

    for (const [relPath, afterCode] of gitStatusAfter.entries()) {
      const beforeCode = snapshot.gitStatusBefore.get(relPath)
      if (beforeCode === afterCode) continue
      const absPath = resolve(snapshot.wsReal, relPath)
      const matchedRule = matchProtectedPath(snapshot.wsReal, absPath, agent.protectedPaths)
      if (!matchedRule) continue

      violations.push({ relPath, rule: matchedRule })
      if (afterCode === '??') {
        try {
          rmSync(absPath, { recursive: true, force: true })
        } catch {
          // ignore
        }
      } else {
        try {
          gitRunner(['reset', 'HEAD', '--', relPath], snapshot.wsReal)
        } catch {
          // ignore on unborn HEAD
        }
        try {
          gitRunner(['checkout', 'HEAD', '--', relPath], snapshot.wsReal)
        } catch {
          try {
            gitRunner(['checkout', '--', relPath], snapshot.wsReal)
          } catch {
            // fallback to hash backup below
          }
        }
      }
    }
  }

  // 2. Filesystem SHA-256 hash verification (catches .gitignore'd `.env`, `store/`, etc. & already-dirty edits)
  for (const snap of snapshot.fileSnapshots.values()) {
    let changed = false
    if (!existsSync(snap.absPath)) {
      changed = true
    } else {
      try {
        const currentHash = sha256Buffer(readFileSync(snap.absPath))
        if (currentHash !== snap.sha256) {
          changed = true
        }
      } catch {
        changed = true
      }
    }

    if (changed) {
      if (!violations.some((v) => v.relPath === snap.relPath)) {
        violations.push({ relPath: snap.relPath, rule: snap.rule })
      }
      if (snap.backupContent !== undefined) {
        try {
          mkdirSync(dirname(snap.absPath), { recursive: true })
          writeFileSync(snap.absPath, snap.backupContent)
        } catch {
          // best-effort restore
        }
      }
    }
  }

  // 3. Newly created files inside previously non-existent protected targets or existing protected directories
  for (const target of snapshot.nonExistentTargets) {
    if (existsSync(target.absPath)) {
      violations.push({ relPath: target.relPath, rule: target.rule })
      try {
        rmSync(target.absPath, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
  }

  for (const dirEntry of snapshot.existingDirFiles.values()) {
    if (!existsSync(dirEntry.absDir)) continue
    const currentFiles: Array<{ relPath: string; absPath: string }> = []
    collectFilesInDir(dirEntry.absDir, dirEntry.absDir, snapshot.wsReal, currentFiles)
    for (const f of currentFiles) {
      if (!dirEntry.files.has(f.relPath) && !isTransientSqliteSidecar(f.relPath)) {
        if (!violations.some((v) => v.relPath === f.relPath)) {
          violations.push({ relPath: f.relPath, rule: dirEntry.rule })
        }
        try {
          rmSync(f.absPath, { recursive: true, force: true })
        } catch {
          // ignore
        }
      }
    }
  }

  if (violations.length > 0) {
    const first = violations[0]
    throw new ProtectedPathError(
      agent.id,
      first.relPath,
      first.rule,
      'fs_write',
      'CLI subprocess modified protected path; reverted automatically',
    )
  }
}

/**
 * Executes an agent turn via a non-interactive headless CLI (`claude-cli`, `codex-cli`, `gemini-cli`)
 * inside the global FIFO mutex with sanitized environment variables, process-group timeout termination,
 * and fail-closed post-run `protectedPaths` verification & rollback.
 */
export async function runCliAgent(opts: RunCliAgentOptions): Promise<CliRunResult> {
  const provider = opts.agent.provider as AlfredCliProviderName
  const envMap = opts.env ?? { ...readEnvFile(), ...process.env }
  const processRunner = opts.processRunner ?? spawnCliProcess
  const gitRunner = opts.gitRunner ?? defaultGitRunner
  const queue = opts.queue ?? getDefaultCliQueue(envMap)
  const timeoutMs = resolveCliTimeoutMs(opts.agent, envMap)
  const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES

  return queue.runExclusive(
    async () => {
      mkdirSync(opts.agent.workspaceAbsPath, { recursive: true })
      const sanitizedEnv = buildSanitizedCliEnv(provider, envMap, opts.agent.cliConfigDir)
      const cmdSpec = buildCliCommandSpec({
        agent: opts.agent,
        userMessage: opts.userMessage,
        conversationHistory: opts.conversationHistory,
        env: envMap,
      })

      const snapshot = captureProtectedSnapshot(opts.agent, gitRunner)

      let spawnResult: CliSpawnResult | null = null
      let caughtError: unknown = null

      try {
        spawnResult = await processRunner({
          command: cmdSpec.command,
          args: cmdSpec.args,
          cwd: opts.agent.workspaceAbsPath,
          env: sanitizedEnv,
          timeoutMs,
          killGraceMs,
          maxOutputBytes,
        })
      } catch (err) {
        caughtError = err
      } finally {
        // Security verification ALWAYS runs, even if the CLI failed or timed out.
        // Any ProtectedPathError thrown here takes precedence over subprocess errors.
        verifyAndRevertProtectedPaths(opts.agent, snapshot, gitRunner)
      }

      if (caughtError) {
        throw caughtError
      }

      const res = spawnResult!
      if (res.spawnErrorCode || res.timedOut || res.exitCode !== 0) {
        const kind = classifyCliError(
          provider,
          res.exitCode,
          res.stderr || res.stdout,
          res.timedOut,
          res.spawnErrorCode,
        )
        const detail = (res.stderr || res.stdout || '').trim()
        logger.warn(
          {
            agentId: opts.agent.id,
            provider,
            kind,
            exitCode: res.exitCode,
            timedOut: res.timedOut,
          },
          'Headless CLI execution failed',
        )
        throw new CliExecutionError({
          provider,
          kind,
          exitCode: res.exitCode,
          stderr: detail,
        })
      }

      return parseCliOutput(provider, res.stdout, opts.agent.model, cmdSpec.promptText)
    },
    { onQueued: opts.onQueued },
  )
}

export function detectCliAuthStatus(
  provider: AlfredCliProviderName,
  env: Record<string, string | undefined>,
): { method: CliAuthMethod; detail?: string } {
  const home = env['HOME'] || env['USERPROFILE'] || ''
  if (provider === 'claude-cli') {
    if ((env['CLAUDE_CODE_OAUTH_TOKEN'] || '').trim()) {
      return { method: 'oauth', detail: 'CLAUDE_CODE_OAUTH_TOKEN (.env)' }
    }
    const dir = env['CLAUDE_CONFIG_DIR']?.trim() || (home ? join(home, '.claude') : '')
    if (dir && existsSync(join(dir, '.credentials.json'))) {
      return { method: 'oauth', detail: '~/.claude/.credentials.json' }
    }
    if (dir && existsSync(join(dir, 'credentials.json'))) {
      return { method: 'oauth', detail: '~/.claude/credentials.json' }
    }
    if ((env['ANTHROPIC_API_KEY'] || '').trim()) {
      return { method: 'api_key', detail: 'ANTHROPIC_API_KEY (.env)' }
    }
    return { method: 'none' }
  }
  if (provider === 'codex-cli') {
    const dir = env['CODEX_HOME']?.trim() || (home ? join(home, '.codex') : '')
    if (dir && existsSync(join(dir, 'auth.json'))) {
      return { method: 'oauth', detail: '~/.codex/auth.json' }
    }
    if (dir && existsSync(join(dir, 'credentials.json'))) {
      return { method: 'oauth', detail: '~/.codex/credentials.json' }
    }
    if ((env['CODEX_API_KEY'] || '').trim()) {
      return { method: 'api_key', detail: 'CODEX_API_KEY (.env)' }
    }
    if ((env['OPENAI_API_KEY'] || '').trim()) {
      return { method: 'api_key', detail: 'OPENAI_API_KEY (.env)' }
    }
    return { method: 'none' }
  }
  if (provider === 'agy-cli') {
    const agyDir = env['AGY_CONFIG_DIR']?.trim() || (home ? join(home, '.gemini', 'antigravity-cli') : '')
    const agyCredFiles = ['antigravity-oauth-token', 'credentials.json', 'oauth_creds.json', 'auth.json', 'tokens.json', 'token.json']
    for (const f of agyCredFiles) {
      if (agyDir && existsSync(join(agyDir, f))) {
        return { method: 'oauth', detail: `~/.gemini/antigravity-cli/${f}` }
      }
    }
    if ((env['AGY_ADC_AUTH'] || '').trim().toLowerCase() === 'true') {
      return { method: 'oauth', detail: 'AGY_ADC_AUTH (GCP ADC)' }
    }
    if ((env['GEMINI_API_KEY'] || '').trim()) {
      return { method: 'api_key', detail: 'GEMINI_API_KEY (.env)' }
    }
    if ((env['GOOGLE_API_KEY'] || '').trim()) {
      return { method: 'api_key', detail: 'GOOGLE_API_KEY (.env)' }
    }
    return { method: 'none' }
  }
  // gemini-cli
  const dir = env['GEMINI_CLI_HOME']?.trim() || (home ? join(home, '.gemini') : '')
  if (dir && existsSync(join(dir, 'oauth_creds.json'))) {
    return { method: 'oauth', detail: '~/.gemini/oauth_creds.json' }
  }
  const googleAccountsPath = dir ? join(dir, 'google_accounts.json') : ''
  if (googleAccountsPath && existsSync(googleAccountsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(googleAccountsPath, 'utf-8')) as { active?: unknown }
      if (typeof parsed?.active === 'string' && parsed.active.trim().length > 0) {
        return { method: 'oauth', detail: `~/.gemini/google_accounts.json (${parsed.active.trim()})` }
      }
    } catch {
      /* ignore malformed google_accounts.json */
    }
  }
  if ((env['GEMINI_API_KEY'] || '').trim()) {
    return { method: 'api_key', detail: 'GEMINI_API_KEY (.env)' }
  }
  if ((env['GOOGLE_API_KEY'] || '').trim()) {
    return { method: 'api_key', detail: 'GOOGLE_API_KEY (.env)' }
  }
  if ((env['GOOGLE_APPLICATION_CREDENTIALS'] || '').trim()) {
    return { method: 'api_key', detail: 'GOOGLE_APPLICATION_CREDENTIALS (.env)' }
  }
  return { method: 'none' }
}

/**
 * Pre-flight health check for `claude-cli`, `codex-cli`, and `gemini-cli`:
 * verifies installed binary (`--version`) and local auth / token readiness.
 */
export async function checkCliProvidersHealth(opts?: {
  env?: Record<string, string | undefined>
  processRunner?: CliProcessRunner
  timeoutMs?: number
}): Promise<CliProviderHealthStatus[]> {
  const envMap = opts?.env ?? { ...readEnvFile(), ...process.env }
  const runner = opts?.processRunner ?? spawnCliProcess
  const timeoutMs = opts?.timeoutMs ?? 5_000
  const providers: AlfredCliProviderName[] = ['claude-cli', 'codex-cli', 'gemini-cli', 'agy-cli']

  return Promise.all(
    providers.map(async (provider) => {
      const binary = resolveCliBinary(provider, envMap)
      const sanitizedEnv = buildSanitizedCliEnv(provider, envMap)
      let installed = false
      let version: string | undefined

      try {
        const res = await runner({
          command: binary,
          args: ['--version'],
          cwd: process.cwd(),
          env: sanitizedEnv,
          timeoutMs,
          killGraceMs: 1_000,
          maxOutputBytes: 16_384,
        })
        if (!res.spawnErrorCode && !res.timedOut && res.exitCode === 0) {
          installed = true
          const line = (res.stdout || res.stderr || '').trim().split(/\r?\n/)[0]?.trim()
          if (line) version = line
        }
      } catch {
        installed = false
      }

      const auth = detectCliAuthStatus(provider, envMap)
      return {
        provider,
        binary,
        installed,
        ...(version ? { version } : {}),
        authConfigured: auth.method !== 'none',
        authMethod: auth.method,
        ...(auth.detail ? { authDetail: auth.detail } : {}),
      }
    }),
  )
}
