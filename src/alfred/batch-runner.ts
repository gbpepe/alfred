import { randomUUID } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type Database from 'better-sqlite3'
import { PROJECT_ROOT } from '../config.js'
import type { TokenPrice } from '../costops/config.js'
import { evaluateAgentBudgets, agentSpend } from '../costops/agent-budgets.js'
import { readEnvFile } from '../env.js'
import { logger } from '../logger.js'
import { wrapUntrusted } from '../prompt-safety.js'
import { scanFile } from '../security/secret-gate.js'
import { composeBatchInjection, type BatchInjectItem } from '../web/batch-inject.js'
import {
  holdStorePath,
  jobKey,
  readHoldStore,
  writeHoldStore,
  type Episode,
  type HoldStore,
} from '../web/heavy-job-hold.js'
import {
  enqueueWorksourceItemAt,
  worksourceItemStageAt,
} from '../web/worksource-queue.js'
import type { AlfredAgentDefinition, AlfredAgentsConfig } from './agents-config.js'
import {
  BudgetExceededError,
  evaluateCircuitBreaker,
  recordModelTokenUsage,
  resolveEffectiveTokenPrices,
} from './circuit-breaker.js'
import type { DiscordSendFn } from './discord-adapter.js'
import { assertVertexEuRegion, resolveVertexEuApiHost, runHybridAgentTurn } from './model-router.js'
import { prefixTestReply, type AlfredRuntimeEnv } from './runtime-env.js'
import { resolveVertexEuAuth } from './vertex-auth.js'

export type BatchProviderName = 'anthropic' | 'gemini' | 'vertex-eu' | 'openai'
export type RequestedBatchProvider = 'auto' | BatchProviderName
export type BatchTaskType = 'code' | 'reasoning' | 'translation' | 'extraction' | 'general'
export type BatchJobStatus =
  | 'queued'
  | 'submitted'
  | 'running'
  | 'downloading'
  | 'completed'
  | 'failed'
  | 'cancelled'

export const BATCH_PROVIDERS: readonly BatchProviderName[] = [
  'anthropic',
  'gemini',
  'vertex-eu',
  'openai',
] as const

export const BATCH_DISCOUNT_MULTIPLIER = 0.5
export const CUSTOM_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/
export const DEFAULT_MAX_ANTHROPIC_BATCH_REQUESTS = 10_000
export const DEFAULT_MAX_ANTHROPIC_BATCH_BYTES = 32 * 1024 * 1024 // 32 MiB
export const ANTHROPIC_EPHEMERAL_CACHE_MIN_CHARS = 4_096 // ~1024 tokens
export const DEFAULT_BATCH_MODELS: Record<BatchProviderName, string> = {
  anthropic: 'claude-sonnet-4-6',
  gemini: 'gemini-2.5-flash',
  'vertex-eu': 'gemini-2.5-flash',
  openai: 'gpt-4o-mini',
}

export interface CanonicalBatchInputItem {
  custom_id: string
  system?: string
  prompt: string
  max_tokens?: number
  task_type?: BatchTaskType
  eu_only?: boolean
}

export interface CanonicalBatchOutputItem {
  custom_id: string
  status: 'ok' | 'error'
  text?: string
  error?: string
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
  cost_usd: number
}

export interface BatchJobRecord {
  id: string
  provider: BatchProviderName
  requested_provider: RequestedBatchProvider
  model: string
  status: BatchJobStatus
  external_batch_id: string | null
  input_path: string
  output_path: string | null
  total_items: number
  completed_items: number
  failed_items: number
  estimated_cost_usd: number
  actual_cost_usd: number | null
  saved_cost_usd: number
  cost_recorded: number
  discord_channel_id: string | null
  error_message: string | null
  created_at: number
  updated_at: number
}

export class BatchValidationError extends Error {
  public readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'BatchValidationError'
    this.code = code
  }
}

export class DuplicateCustomIdError extends BatchValidationError {
  public readonly customId: string
  public readonly lineNumber: number
  constructor(customId: string, lineNumber: number) {
    super('DUPLICATE_CUSTOM_ID', `Duplicate custom_id "${customId}" at line ${lineNumber}`)
    this.name = 'DuplicateCustomIdError'
    this.customId = customId
    this.lineNumber = lineNumber
  }
}

export class BatchSecretGateError extends BatchValidationError {
  public readonly lineNumber: number
  public readonly reasons: string[]
  constructor(lineNumber: number, reasons: string[]) {
    super(
      'BATCH_SECRET_GATE_BLOCKED',
      `Secret gate blocked batch upload at line ${lineNumber}: ${reasons.join('; ')}`,
    )
    this.name = 'BatchSecretGateError'
    this.lineNumber = lineNumber
    this.reasons = reasons
  }
}

export class BatchPayloadTooLargeError extends BatchValidationError {
  constructor(message: string) {
    super('BATCH_PAYLOAD_TOO_LARGE', message)
    this.name = 'BatchPayloadTooLargeError'
  }
}

export class BatchEuOnlyError extends BatchValidationError {
  constructor(message: string) {
    super('GDPR_EU_ONLY_BATCH_ERROR', message)
    this.name = 'BatchEuOnlyError'
  }
}

export class BatchPathBoundaryError extends BatchValidationError {
  constructor(message: string) {
    super('BATCH_PATH_BOUNDARY_VIOLATION', message)
    this.name = 'BatchPathBoundaryError'
  }
}

/**
 * In-process poll lock so Heartbeat and manual `batch_status(poll: true)` never
 * poll/download the same batch concurrently.
 */
const inFlightPollIds = new Set<string>()

/** Cached GCS bucket location verification (bucketName -> uppercase location) */
const gcsBucketLocationCache = new Map<string, string>()

export function clearBatchRunnerCaches(): void {
  inFlightPollIds.clear()
  gcsBucketLocationCache.clear()
}

export function batchWorksourceQueueRoot(projectRoot: string = PROJECT_ROOT): string {
  return join(resolve(projectRoot), 'store', 'batch', 'worksource-queue')
}

export function ensureBatchJobsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS batch_jobs (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL CHECK(provider IN ('anthropic','gemini','vertex-eu','openai')),
      requested_provider TEXT NOT NULL DEFAULT 'auto',
      model TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','submitted','running','downloading','completed','failed','cancelled')),
      external_batch_id TEXT,
      input_path TEXT NOT NULL,
      output_path TEXT,
      total_items INTEGER NOT NULL DEFAULT 0,
      completed_items INTEGER NOT NULL DEFAULT 0,
      failed_items INTEGER NOT NULL DEFAULT 0,
      estimated_cost_usd REAL NOT NULL DEFAULT 0,
      actual_cost_usd REAL,
      saved_cost_usd REAL NOT NULL DEFAULT 0,
      cost_recorded INTEGER NOT NULL DEFAULT 0,
      discord_channel_id TEXT,
      error_message TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_batch_jobs_status ON batch_jobs(status, updated_at)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_batch_jobs_provider ON batch_jobs(provider, created_at)`)
  // Idempotent additive migrations for existing DBs
  try { db.exec(`ALTER TABLE batch_jobs ADD COLUMN actual_cost_usd REAL`) } catch { /* exists */ }
  try { db.exec(`ALTER TABLE batch_jobs ADD COLUMN cost_recorded INTEGER NOT NULL DEFAULT 0`) } catch { /* exists */ }
  try { db.exec(`ALTER TABLE batch_jobs ADD COLUMN error_message TEXT`) } catch { /* exists */ }
}

/**
 * Resolves and strictly confines a batch file path to `<projectRoot>/batch/` or `<projectRoot>/store/batch/`.
 * Uses `realpathSync` to prevent symlink escapes.
 */
export function resolveBatchConfinedPath(
  projectRoot: string,
  requestedPath: string,
  opts: { mustExist?: boolean } = {},
): string {
  const clean = (requestedPath ?? '').trim()
  if (!clean) {
    throw new BatchPathBoundaryError('Batch path must be non-empty')
  }
  const rootAbs = existsSync(projectRoot) ? realpathSync(projectRoot) : resolve(projectRoot)
  const batchDir = join(rootAbs, 'batch')
  const storeBatchDir = join(rootAbs, 'store', 'batch')
  mkdirSync(batchDir, { recursive: true })
  mkdirSync(storeBatchDir, { recursive: true })
  const allowedRoots = [realpathSync(batchDir), realpathSync(storeBatchDir)]

  const candidate = isAbsolute(clean) ? resolve(clean) : resolve(rootAbs, clean)

  const isInsideAllowed = (absPath: string): boolean => {
    return allowedRoots.some((allowed) => {
      const rel = relative(allowed, absPath)
      return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
    })
  }

  if (!isInsideAllowed(candidate)) {
    throw new BatchPathBoundaryError(
      `Batch path "${clean}" is outside allowed directories (batch/ and store/batch/)`,
    )
  }

  if (opts.mustExist) {
    if (!existsSync(candidate)) {
      throw new BatchValidationError('BATCH_INPUT_NOT_FOUND', `Batch input file not found: ${clean}`)
    }
    const realTarget = realpathSync(candidate)
    if (!isInsideAllowed(realTarget)) {
      throw new BatchPathBoundaryError(
        `Symlinked batch path "${clean}" escapes allowed directories (batch/ and store/batch/)`,
      )
    }
    if (!statSync(realTarget).isFile()) {
      throw new BatchValidationError('BATCH_INPUT_NOT_FILE', `Batch input path is not a regular file: ${clean}`)
    }
    return realTarget
  }

  // For write paths: resolve the nearest existing parent and check realpath
  let probe = candidate
  while (!existsSync(probe)) {
    const parent = dirname(probe)
    if (parent === probe) break
    probe = parent
  }
  if (existsSync(probe)) {
    const realParent = realpathSync(probe)
    const allowedOrRoot = allowedRoots.some((allowed) => {
      const rel = relative(allowed, realParent)
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
    })
    if (!allowedOrRoot) {
      throw new BatchPathBoundaryError(
        `Batch target parent for "${clean}" escapes allowed directories (batch/ and store/batch/)`,
      )
    }
  }
  return candidate
}

/**
 * Transitions a job-level worksource-queue item atomically between stages (`pending` -> `active` -> `done`).
 */
export function transitionBatchWorksourceStage(
  queueRoot: string,
  jobId: string,
  targetStage: 'active' | 'done',
): boolean {
  for (const dir of ['pending', 'active', 'done']) {
    mkdirSync(join(queueRoot, dir), { recursive: true })
  }
  const currentStage = worksourceItemStageAt(queueRoot, jobId)
  if (!currentStage || currentStage === targetStage) return false
  const src = join(queueRoot, currentStage, `${jobId}.json`)
  const dst = join(queueRoot, targetStage, `${jobId}.json`)
  try {
    renameSync(src, dst)
    return true
  } catch {
    return false
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code
    // EPERM means the process exists but belongs to another user
    return code === 'EPERM'
  }
}

const BATCH_HOLD_AGENT_KEY = 'alfred-batch'

/**
 * Acquires a `heavy-job-hold` entry in `store/context-guard-heavy-holds.json` for the
 * duration of critical batch I/O (canonical JSONL assembly or output download/translation),
 * protecting against mid-I/O restarts.
 */
export async function withBatchHeavyJobHold<T>(
  projectRoot: string,
  jobId: string,
  fn: () => Promise<T>,
  nowMs: number = Date.now(),
): Promise<T> {
  const storeFile = holdStorePath(projectRoot)
  const pid = process.pid
  const start = String(Math.floor(nowMs / 1000))
  const entry = {
    pid,
    start,
    label: `batch:${jobId}`.replace(/[^A-Za-z0-9._:-]/g, '_'),
    state: 'running' as const,
    firstSeenMs: nowMs,
    alerted: false,
  }
  const k = jobKey(entry)

  const register = () => {
    try {
      mkdirSync(dirname(storeFile), { recursive: true })
      let store: HoldStore = {}
      try {
        store = readHoldStore(storeFile)
      } catch {
        store = {}
      }
      const existing: Episode = store[BATCH_HOLD_AGENT_KEY] ?? {
        startMs: nowMs,
        panes: [pid],
        jobs: {},
      }
      existing.jobs[k] = entry
      store[BATCH_HOLD_AGENT_KEY] = existing
      writeHoldStore(storeFile, store)
    } catch (err) {
      logger.debug({ err, jobId }, 'Failed to register batch heavy-job-hold (non-fatal)')
    }
  }

  const release = () => {
    try {
      let store: HoldStore = {}
      try {
        store = readHoldStore(storeFile)
      } catch {
        return
      }
      const ep = store[BATCH_HOLD_AGENT_KEY]
      if (!ep) return
      delete ep.jobs[k]
      if (Object.keys(ep.jobs).length === 0) {
        delete store[BATCH_HOLD_AGENT_KEY]
      }
      writeHoldStore(storeFile, store)
    } catch (err) {
      logger.debug({ err, jobId }, 'Failed to release batch heavy-job-hold (non-fatal)')
    }
  }

  register()
  try {
    return await fn()
  } finally {
    release()
  }
}

/**
 * Startup crash-recovery for the Batch subsystem:
 * 1. Reverts any `batch_jobs` rows stuck in `downloading` (from an unclean crash) back to `running`.
 * 2. Removes orphaned `batch:*` entries in `heavy-job-hold` whose PID is no longer alive.
 */
export function recoverStuckBatchJobs(
  db: Database.Database,
  projectRoot: string = PROJECT_ROOT,
  opts: { isPidAliveFn?: (pid: number) => boolean; nowSec?: number } = {},
): { recoveredDownloadingJobs: number; cleanedOrphanHolds: number } {
  ensureBatchJobsTable(db)
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000)
  const checkAlive = opts.isPidAliveFn ?? isPidAlive

  const res = db
    .prepare(
      `UPDATE batch_jobs SET status = 'running', updated_at = ? WHERE status = 'downloading'`,
    )
    .run(nowSec)
  const recoveredDownloadingJobs = Number(res.changes ?? 0)

  let cleanedOrphanHolds = 0
  const storeFile = holdStorePath(projectRoot)
  if (existsSync(storeFile)) {
    try {
      const store = readHoldStore(storeFile)
      let modified = false
      for (const [agentKey, ep] of Object.entries(store)) {
        for (const [k, entry] of Object.entries(ep.jobs)) {
          if (!entry.label.startsWith('batch:')) continue
          if (!checkAlive(entry.pid)) {
            delete ep.jobs[k]
            cleanedOrphanHolds += 1
            modified = true
          }
        }
        if (Object.keys(ep.jobs).length === 0) {
          delete store[agentKey]
          modified = true
        }
      }
      if (modified) {
        writeHoldStore(storeFile, store)
      }
    } catch (err) {
      logger.warn({ err }, 'recoverStuckBatchJobs: failed to clean hold store')
    }
  }

  return { recoveredDownloadingJobs, cleanedOrphanHolds }
}

/**
 * Computes the 50% Batch API cost and baseline (real-time) cost for a single item or aggregate usage.
 * Supports Anthropic/OpenAI/Gemini cache creation and cache read tokens.
 */
export function computeBatchCostBreakdown(
  model: string,
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  },
  prices: Record<string, TokenPrice> = resolveEffectiveTokenPrices(),
): { batchCostUsd: number; baselineCostUsd: number; savedCostUsd: number } {
  const p = prices[model]
  if (!p) {
    return { batchCostUsd: 0, baselineCostUsd: 0, savedCostUsd: 0 }
  }
  const input = Math.max(0, usage.input_tokens || 0)
  const output = Math.max(0, usage.output_tokens || 0)
  const cacheCreate = Math.max(0, usage.cache_creation_input_tokens || 0)
  const cacheRead = Math.max(0, usage.cache_read_input_tokens || 0)

  const cwPrice = typeof p.cache_write === 'number' ? p.cache_write : p.input
  const crPrice = typeof p.cache_read === 'number' ? p.cache_read : p.input

  const baselineCostUsd =
    (input * p.input) / 1e6 +
    (output * p.output) / 1e6 +
    (cacheCreate * cwPrice) / 1e6 +
    (cacheRead * crPrice) / 1e6

  const batchCostUsd = baselineCostUsd * BATCH_DISCOUNT_MULTIPLIER
  const savedCostUsd = Math.max(0, baselineCostUsd - batchCostUsd)
  return { batchCostUsd, baselineCostUsd, savedCostUsd }
}

export function isBatchProviderConfigured(
  provider: BatchProviderName,
  env: Record<string, string | undefined>,
): boolean {
  if (provider === 'anthropic') {
    return Boolean((env['ANTHROPIC_API_KEY'] ?? '').trim())
  }
  if (provider === 'gemini') {
    return Boolean((env['GEMINI_API_KEY'] ?? '').trim())
  }
  if (provider === 'openai') {
    return Boolean((env['OPENAI_API_KEY'] ?? '').trim())
  }
  if (provider === 'vertex-eu') {
    const bucket = (env['VERTEX_EU_BATCH_BUCKET'] ?? '').trim()
    if (!bucket) return false
    const hasAuth = Boolean(
      (env['VERTEX_EU_ACCESS_TOKEN'] ?? '').trim() ||
      (env['GOOGLE_APPLICATION_CREDENTIALS'] ?? '').trim() ||
      (env['VERTEX_EU_PROJECT_ID'] ?? '').trim(),
    )
    if (!hasAuth) return false
    const rawLocation = (env['VERTEX_EU_BATCH_LOCATION'] ?? env['VERTEX_EU_LOCATION'] ?? 'europe-central2').trim()
    try {
      assertVertexEuRegion(rawLocation)
      return true
    } catch {
      return false
    }
  }
  return false
}

export interface ResolveBatchProviderInput {
  requestedProvider?: RequestedBatchProvider
  taskType?: BatchTaskType
  euOnly?: boolean
  env: Record<string, string | undefined>
}

export interface ResolvedBatchProviderPlan {
  primary: BatchProviderName
  candidates: BatchProviderName[]
  euOnly: boolean
}

/**
 * Resolves the target Batch provider and ordered fallback chain based on API keys,
 * `eu_only` GDPR constraint, and `task_type`.
 */
export function resolveBatchProvider(input: ResolveBatchProviderInput): ResolvedBatchProviderPlan {
  const requested = input.requestedProvider ?? 'auto'
  const euOnly = input.euOnly === true

  if (euOnly) {
    if (requested !== 'auto' && requested !== 'vertex-eu') {
      throw new BatchEuOnlyError(
        `GDPR_EU_ONLY_BATCH_ERROR: eu_only=true requires provider "vertex-eu" (got "${requested}")`,
      )
    }
    if (!isBatchProviderConfigured('vertex-eu', input.env)) {
      throw new BatchEuOnlyError(
        'GDPR_EU_ONLY_BATCH_ERROR: eu_only=true requires configured vertex-eu (VERTEX_EU_BATCH_BUCKET + EU location + Vertex auth). Refusing non-EU fallback.',
      )
    }
    return { primary: 'vertex-eu', candidates: ['vertex-eu'], euOnly: true }
  }

  let preferenceOrder: BatchProviderName[]
  if (requested !== 'auto') {
    const rest = BATCH_PROVIDERS.filter((p) => p !== requested)
    preferenceOrder = [requested, ...rest]
  } else if (input.taskType === 'code' || input.taskType === 'reasoning') {
    preferenceOrder = ['anthropic', 'gemini', 'vertex-eu', 'openai']
  } else {
    preferenceOrder = ['gemini', 'vertex-eu', 'openai', 'anthropic']
  }

  const configured = preferenceOrder.filter((p) => isBatchProviderConfigured(p, input.env))
  if (configured.length === 0) {
    throw new BatchValidationError(
      'NO_BATCH_PROVIDER_CONFIGURED',
      'No Batch API provider is configured (need ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY, or VERTEX_EU_BATCH_BUCKET + Vertex EU auth).',
    )
  }

  return {
    primary: configured[0],
    candidates: configured,
    euOnly: false,
  }
}

export interface ValidatedCanonicalScan {
  totalItems: number
  dominantTaskType: BatchTaskType
  anyEuOnly: boolean
  estimatedInputTokens: number
  estimatedOutputTokens: number
  sharedLongSystemPrefixes: Set<string>
}

/**
 * Streams a canonical JSONL input file line-by-line to:
 * 1. Validate JSON structure and strict `custom_id` format (`/^[a-zA-Z0-9_-]{1,64}$/`).
 * 2. Deduplicate `custom_id` via an in-memory `Set<string>` (no per-line queue files).
 * 3. Run `src/security/secret-gate.ts` (`scanFile`) on every line's prompt/system content.
 *    Error messages never leak raw file content or matched secrets.
 * 4. Count shared long system prefixes (>= 4096 chars & count >= 2) for Anthropic ephemeral prompt caching.
 * 5. Estimate input/output token counts for pre-flight budget checks.
 */
export async function validateAndScanCanonicalJsonl(
  absInputPath: string,
  relLabel: string,
): Promise<ValidatedCanonicalScan> {
  const seenIds = new Set<string>()
  const taskTypeCounts = new Map<BatchTaskType, number>()
  const systemPrefixCounts = new Map<string, number>()
  let anyEuOnly = false
  let totalItems = 0
  let estimatedInputTokens = 0
  let estimatedOutputTokens = 0
  let lineNumber = 0

  const rl = createInterface({
    input: createReadStream(absInputPath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  })

  for await (const rawLine of rl) {
    lineNumber += 1
    const trimmed = rawLine.trim()
    if (!trimmed) continue

    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      throw new BatchValidationError(
        'INVALID_JSONL_LINE',
        `Malformed JSON object at line ${lineNumber} of ${basename(relLabel)}`,
      )
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new BatchValidationError(
        'INVALID_JSONL_OBJECT',
        `Expected JSON object at line ${lineNumber} of ${basename(relLabel)}`,
      )
    }

    const obj = parsed as Record<string, unknown>
    const customId = typeof obj.custom_id === 'string' ? obj.custom_id.trim() : ''
    if (!customId || !CUSTOM_ID_RE.test(customId)) {
      throw new BatchValidationError(
        'INVALID_CUSTOM_ID',
        `Invalid custom_id at line ${lineNumber} (must match ${CUSTOM_ID_RE})`,
      )
    }
    if (seenIds.has(customId)) {
      throw new DuplicateCustomIdError(customId, lineNumber)
    }
    seenIds.add(customId)

    const prompt = typeof obj.prompt === 'string' ? obj.prompt : ''
    if (!prompt.trim()) {
      throw new BatchValidationError(
        'MISSING_PROMPT',
        `Missing non-empty "prompt" at line ${lineNumber} (custom_id="${customId}")`,
      )
    }

    const system = typeof obj.system === 'string' ? obj.system : ''
    const scanText = system ? `${system}\n${prompt}` : prompt
    const findings = scanFile({ path: relLabel, content: scanText })
    if (findings.length > 0) {
      throw new BatchSecretGateError(
        lineNumber,
        findings.map((f) => f.reason),
      )
    }

    if (obj.eu_only === true) {
      anyEuOnly = true
    }

    const tt = typeof obj.task_type === 'string' ? (obj.task_type.trim() as BatchTaskType) : 'general'
    const validTt: BatchTaskType =
      tt === 'code' || tt === 'reasoning' || tt === 'translation' || tt === 'extraction' || tt === 'general'
        ? tt
        : 'general'
    taskTypeCounts.set(validTt, (taskTypeCounts.get(validTt) ?? 0) + 1)

    if (system.length >= ANTHROPIC_EPHEMERAL_CACHE_MIN_CHARS) {
      systemPrefixCounts.set(system, (systemPrefixCounts.get(system) ?? 0) + 1)
    }

    const maxTokens =
      typeof obj.max_tokens === 'number' && Number.isFinite(obj.max_tokens) && obj.max_tokens > 0
        ? Math.min(32_768, Math.floor(obj.max_tokens))
        : 1024

    estimatedInputTokens += Math.max(1, Math.ceil((system.length + prompt.length) / 4))
    estimatedOutputTokens += maxTokens
    totalItems += 1
  }

  if (totalItems === 0) {
    throw new BatchValidationError('EMPTY_BATCH_INPUT', 'Canonical JSONL input file contains 0 items')
  }

  let dominantTaskType: BatchTaskType = 'general'
  let topCount = -1
  for (const [tt, count] of taskTypeCounts.entries()) {
    if (count > topCount) {
      dominantTaskType = tt
      topCount = count
    }
  }

  const sharedLongSystemPrefixes = new Set<string>()
  for (const [sys, count] of systemPrefixCounts.entries()) {
    if (count >= 2) {
      sharedLongSystemPrefixes.add(sys)
    }
  }

  return {
    totalItems,
    dominantTaskType,
    anyEuOnly,
    estimatedInputTokens,
    estimatedOutputTokens,
    sharedLongSystemPrefixes,
  }
}

async function* streamCanonicalItems(absInputPath: string): AsyncGenerator<CanonicalBatchInputItem> {
  const rl = createInterface({
    input: createReadStream(absInputPath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  })
  for await (const rawLine of rl) {
    const trimmed = rawLine.trim()
    if (!trimmed) continue
    yield JSON.parse(trimmed) as CanonicalBatchInputItem
  }
}

// ============================================================================
// 4 Native Batch Provider Adapters
// ============================================================================

export interface AdapterSubmitContext {
  jobId: string
  model: string
  absInputPath: string
  scan: ValidatedCanonicalScan
  euOnly: boolean
  env: Record<string, string | undefined>
  projectRoot: string
  fetchImpl: typeof fetch
  maxAnthropicRequests?: number
  maxAnthropicBytes?: number
}

export interface AdapterPollResult {
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  completedItems?: number
  failedItems?: number
  outputItems?: CanonicalBatchOutputItem[]
  errorMessage?: string
}

// --- 1. Anthropic Messages Batches Adapter ---

export function buildAnthropicBatchRequestItem(
  item: CanonicalBatchInputItem,
  model: string,
  sharedLongSystemPrefixes: ReadonlySet<string>,
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    model,
    max_tokens: item.max_tokens ?? 1024,
    messages: [{ role: 'user', content: item.prompt }],
  }
  if (item.system && item.system.trim()) {
    const useEphemeralCache =
      item.system.length >= ANTHROPIC_EPHEMERAL_CACHE_MIN_CHARS &&
      sharedLongSystemPrefixes.has(item.system)
    params.system = [
      {
        type: 'text',
        text: item.system,
        ...(useEphemeralCache ? { cache_control: { type: 'ephemeral' } } : {}),
      },
    ]
  }
  return {
    custom_id: item.custom_id,
    params,
  }
}

async function submitAnthropicBatch(ctx: AdapterSubmitContext): Promise<{ externalBatchId: string }> {
  const apiKey = (ctx.env['ANTHROPIC_API_KEY'] ?? '').trim()
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is missing')
  const baseUrl = (ctx.env['ANTHROPIC_BASE_URL'] ?? 'https://api.anthropic.com').replace(/\/+$/, '')

  const maxRequests = ctx.maxAnthropicRequests ?? DEFAULT_MAX_ANTHROPIC_BATCH_REQUESTS
  const maxBytes = ctx.maxAnthropicBytes ?? DEFAULT_MAX_ANTHROPIC_BATCH_BYTES
  if (ctx.scan.totalItems > maxRequests) {
    throw new BatchPayloadTooLargeError(
      `Anthropic batch limit exceeded: ${ctx.scan.totalItems} requests > max ${maxRequests}. Split the JSONL into smaller chunks.`,
    )
  }

  const requests: Array<Record<string, unknown>> = []
  let approxBytes = 20
  for await (const item of streamCanonicalItems(ctx.absInputPath)) {
    const reqObj = buildAnthropicBatchRequestItem(item, ctx.model, ctx.scan.sharedLongSystemPrefixes)
    approxBytes += Buffer.byteLength(JSON.stringify(reqObj), 'utf-8') + 2
    if (approxBytes > maxBytes) {
      throw new BatchPayloadTooLargeError(
        `Anthropic batch payload size limit exceeded (> ${maxBytes} bytes). Split the JSONL into smaller chunks.`,
      )
    }
    requests.push(reqObj)
  }

  const resp = await ctx.fetchImpl(`${baseUrl}/v1/messages/batches`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ requests }),
  })

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`Anthropic Batches submit error ${resp.status}: ${errText.slice(0, 240)}`)
  }
  const data = (await resp.json()) as { id?: string }
  if (!data.id) throw new Error('Anthropic Batches API returned no batch id')
  return { externalBatchId: data.id }
}

async function pollAnthropicBatch(
  job: BatchJobRecord,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
  prices: Record<string, TokenPrice>,
): Promise<AdapterPollResult> {
  const apiKey = (env['ANTHROPIC_API_KEY'] ?? '').trim()
  const baseUrl = (env['ANTHROPIC_BASE_URL'] ?? 'https://api.anthropic.com').replace(/\/+$/, '')
  const resp = await fetchImpl(
    `${baseUrl}/v1/messages/batches/${encodeURIComponent(job.external_batch_id!)}`,
    {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    },
  )
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`Anthropic Batches poll error ${resp.status}: ${errText.slice(0, 240)}`)
  }
  const data = (await resp.json()) as {
    processing_status?: string
    results_url?: string | null
    request_counts?: {
      processing?: number
      succeeded?: number
      errored?: number
      canceled?: number
      expired?: number
    }
  }
  const counts = data.request_counts ?? {}
  if (data.processing_status !== 'ended') {
    return {
      status: 'running',
      completedItems: counts.succeeded ?? 0,
      failedItems: (counts.errored ?? 0) + (counts.expired ?? 0),
    }
  }

  if (!data.results_url) {
    if ((counts.canceled ?? 0) > 0 && (counts.succeeded ?? 0) === 0) {
      return { status: 'cancelled', completedItems: 0, failedItems: counts.canceled ?? 0 }
    }
    return { status: 'failed', errorMessage: 'Anthropic batch ended without results_url' }
  }

  const resResp = await fetchImpl(data.results_url, {
    method: 'GET',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
  })
  if (!resResp.ok) {
    throw new Error(`Anthropic results download error ${resResp.status}`)
  }
  const rawJsonl = await resResp.text()
  const outputItems: CanonicalBatchOutputItem[] = []
  for (const line of rawJsonl.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const row = JSON.parse(trimmed) as {
      custom_id?: string
      result?: {
        type?: string
        message?: {
          content?: Array<{ type?: string; text?: string }>
          usage?: {
            input_tokens?: number
            output_tokens?: number
            cache_creation_input_tokens?: number
            cache_read_input_tokens?: number
          }
        }
        error?: { message?: string; type?: string }
      }
    }
    const cid = row.custom_id ?? 'unknown'
    if (row.result?.type === 'succeeded' && row.result.message) {
      const text = (row.result.message.content ?? [])
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n')
      const u = row.result.message.usage ?? {}
      const usage = {
        input_tokens: u.input_tokens ?? 0,
        output_tokens: u.output_tokens ?? 0,
        ...(u.cache_creation_input_tokens ? { cache_creation_input_tokens: u.cache_creation_input_tokens } : {}),
        ...(u.cache_read_input_tokens ? { cache_read_input_tokens: u.cache_read_input_tokens } : {}),
      }
      const { batchCostUsd } = computeBatchCostBreakdown(job.model, usage, prices)
      outputItems.push({ custom_id: cid, status: 'ok', text, usage, cost_usd: batchCostUsd })
    } else {
      outputItems.push({
        custom_id: cid,
        status: 'error',
        error: row.result?.error?.message ?? row.result?.type ?? 'unknown_error',
        usage: { input_tokens: 0, output_tokens: 0 },
        cost_usd: 0,
      })
    }
  }
  return { status: 'completed', outputItems }
}

async function cancelAnthropicBatch(
  job: BatchJobRecord,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
): Promise<void> {
  const apiKey = (env['ANTHROPIC_API_KEY'] ?? '').trim()
  const baseUrl = (env['ANTHROPIC_BASE_URL'] ?? 'https://api.anthropic.com').replace(/\/+$/, '')
  const resp = await fetchImpl(
    `${baseUrl}/v1/messages/batches/${encodeURIComponent(job.external_batch_id!)}/cancel`,
    {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    },
  )
  if (!resp.ok && resp.status !== 404 && resp.status !== 409) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`Anthropic Batches cancel error ${resp.status}: ${errText.slice(0, 200)}`)
  }
}

// --- 2. Google Gemini Batch API Adapter ---

export function toGeminiBatchLine(item: CanonicalBatchInputItem): string {
  const request: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: item.prompt }] }],
    generationConfig: {
      maxOutputTokens: item.max_tokens ?? 1024,
    },
  }
  if (item.system && item.system.trim()) {
    request.system_instruction = { parts: [{ text: item.system }] }
  }
  return JSON.stringify({ key: item.custom_id, request })
}

async function submitGeminiBatch(ctx: AdapterSubmitContext): Promise<{ externalBatchId: string }> {
  const apiKey = (ctx.env['GEMINI_API_KEY'] ?? '').trim()
  if (!apiKey) throw new Error('GEMINI_API_KEY is missing')
  const apiBase = (ctx.env['GEMINI_BATCH_API_BASE'] ?? 'https://generativelanguage.googleapis.com').replace(/\/+$/, '')

  // Stream canonical JSONL to a temporary Gemini JSONL file
  const tmpGeminiPath = join(dirname(ctx.absInputPath), `.${ctx.jobId}.gemini-input.jsonl`)
  const ws = createWriteStream(tmpGeminiPath, { encoding: 'utf-8' })
  for await (const item of streamCanonicalItems(ctx.absInputPath)) {
    ws.write(toGeminiBatchLine(item) + '\n')
  }
  await new Promise<void>((res, rej) => {
    ws.on('finish', res)
    ws.on('error', rej)
    ws.end()
  })

  try {
    const fileBytes = readFileSync(tmpGeminiPath)
    // Upload via Gemini Files API using x-goog-api-key header + raw/media protocol
    const uploadResp = await ctx.fetchImpl(`${apiBase}/upload/v1beta/files`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'X-Goog-Upload-Protocol': 'raw',
        'X-Goog-Upload-Command': 'start, upload, finalize',
        'X-Goog-Upload-Header-Content-Type': 'application/jsonl',
        'Content-Type': 'application/jsonl',
      },
      body: fileBytes,
    })
    if (!uploadResp.ok) {
      const errText = await uploadResp.text().catch(() => '')
      throw new Error(`Gemini File upload error ${uploadResp.status}: ${errText.slice(0, 240)}`)
    }
    const uploadData = (await uploadResp.json()) as { file?: { name?: string }; name?: string }
    const fileName = uploadData.file?.name ?? uploadData.name
    if (!fileName) throw new Error('Gemini File upload returned no file.name')

    const batchResp = await ctx.fetchImpl(
      `${apiBase}/v1beta/models/${encodeURIComponent(ctx.model)}:batchGenerateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          batch: {
            display_name: `alfred-batch-${ctx.jobId}`,
            input_config: {
              file_name: fileName,
            },
          },
        }),
      },
    )
    if (!batchResp.ok) {
      const errText = await batchResp.text().catch(() => '')
      throw new Error(`Gemini batchGenerateContent error ${batchResp.status}: ${errText.slice(0, 240)}`)
    }
    const batchData = (await batchResp.json()) as { name?: string }
    if (!batchData.name) throw new Error('Gemini batchGenerateContent returned no operation/batch name')
    return { externalBatchId: batchData.name }
  } finally {
    try { unlinkSync(tmpGeminiPath) } catch { /* ignore */ }
  }
}

async function pollGeminiBatch(
  job: BatchJobRecord,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
  prices: Record<string, TokenPrice>,
): Promise<AdapterPollResult> {
  const apiKey = (env['GEMINI_API_KEY'] ?? '').trim()
  const apiBase = (env['GEMINI_BATCH_API_BASE'] ?? 'https://generativelanguage.googleapis.com').replace(/\/+$/, '')
  const batchPath = job.external_batch_id!.replace(/^\/+/, '')

  const resp = await fetchImpl(`${apiBase}/v1beta/${batchPath}`, {
    method: 'GET',
    headers: { 'x-goog-api-key': apiKey },
  })
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`Gemini batch poll error ${resp.status}: ${errText.slice(0, 240)}`)
  }
  const data = (await resp.json()) as {
    done?: boolean
    metadata?: { state?: string; batchStats?: { successfulRequestCount?: string | number; failedRequestCount?: string | number } }
    response?: { responsesFile?: string; output_file_name?: string }
    error?: { message?: string }
  }

  const state = data.metadata?.state ?? ''
  if (state === 'BATCH_STATE_CANCELLED') {
    return { status: 'cancelled' }
  }
  if (state === 'BATCH_STATE_FAILED' || data.error) {
    return { status: 'failed', errorMessage: data.error?.message ?? `Gemini batch failed (${state})` }
  }
  if (!data.done && state !== 'BATCH_STATE_SUCCEEDED') {
    return {
      status: 'running',
      completedItems: Number(data.metadata?.batchStats?.successfulRequestCount ?? 0),
      failedItems: Number(data.metadata?.batchStats?.failedRequestCount ?? 0),
    }
  }

  const outputFile = data.response?.responsesFile ?? data.response?.output_file_name
  if (!outputFile) {
    return { status: 'failed', errorMessage: 'Gemini batch completed without responsesFile' }
  }

  // Strictly pass API key via `x-goog-api-key` header (never query param)
  const cleanFile = outputFile.replace(/^\/+/, '')
  const dlResp = await fetchImpl(`${apiBase}/download/v1beta/${cleanFile}:download?alt=media`, {
    method: 'GET',
    headers: { 'x-goog-api-key': apiKey },
  })
  if (!dlResp.ok) {
    throw new Error(`Gemini batch output download error ${dlResp.status}`)
  }
  const rawJsonl = await dlResp.text()
  const outputItems: CanonicalBatchOutputItem[] = []
  for (const line of rawJsonl.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const row = JSON.parse(trimmed) as {
      key?: string
      custom_id?: string
      response?: {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
        usageMetadata?: {
          promptTokenCount?: number
          candidatesTokenCount?: number
          cachedContentTokenCount?: number
        }
      }
      error?: { message?: string }
    }
    const cid = row.key ?? row.custom_id ?? 'unknown'
    if (row.error) {
      outputItems.push({
        custom_id: cid,
        status: 'error',
        error: row.error.message ?? 'gemini_batch_item_error',
        usage: { input_tokens: 0, output_tokens: 0 },
        cost_usd: 0,
      })
      continue
    }
    const text = (row.response?.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('\n')
      .trim()
    const u = row.response?.usageMetadata ?? {}
    const cached = u.cachedContentTokenCount ?? 0
    const uncachedInput = Math.max(0, (u.promptTokenCount ?? 0) - cached)
    const usage = {
      input_tokens: uncachedInput,
      output_tokens: u.candidatesTokenCount ?? 0,
      ...(cached > 0 ? { cache_read_input_tokens: cached } : {}),
    }
    const { batchCostUsd } = computeBatchCostBreakdown(job.model, usage, prices)
    outputItems.push({ custom_id: cid, status: 'ok', text, usage, cost_usd: batchCostUsd })
  }
  return { status: 'completed', outputItems }
}

async function cancelGeminiBatch(
  job: BatchJobRecord,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
): Promise<void> {
  const apiKey = (env['GEMINI_API_KEY'] ?? '').trim()
  const apiBase = (env['GEMINI_BATCH_API_BASE'] ?? 'https://generativelanguage.googleapis.com').replace(/\/+$/, '')
  const batchPath = job.external_batch_id!.replace(/^\/+/, '')
  const resp = await fetchImpl(`${apiBase}/v1beta/${batchPath}:cancel`, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey },
  })
  if (!resp.ok && resp.status !== 404 && resp.status !== 409) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`Gemini batch cancel error ${resp.status}: ${errText.slice(0, 200)}`)
  }
}

// --- 3. Google Vertex AI EU (GCS + Batch Prediction) Adapter ---

export function toVertexEuBatchLine(item: CanonicalBatchInputItem): string {
  const request: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: item.prompt }] }],
    generationConfig: {
      maxOutputTokens: item.max_tokens ?? 1024,
    },
  }
  if (item.system && item.system.trim()) {
    request.systemInstruction = { parts: [{ text: item.system }] }
  }
  return JSON.stringify({ custom_id: item.custom_id, request })
}

async function verifyGcsBucketEuLocation(
  bucket: string,
  accessToken: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const cached = gcsBucketLocationCache.get(bucket)
  if (cached) {
    assertVertexEuRegion(cached)
    return cached
  }
  const resp = await fetchImpl(
    `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}?fields=location`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  )
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new BatchEuOnlyError(
      `GDPR_EU_ONLY_BATCH_ERROR: Failed to verify GCS bucket "${bucket}" location (HTTP ${resp.status}): ${errText.slice(0, 160)}`,
    )
  }
  const meta = (await resp.json()) as { location?: string }
  const loc = (meta.location ?? '').trim().toLowerCase()
  try {
    assertVertexEuRegion(loc)
  } catch {
    throw new BatchEuOnlyError(
      `GDPR_EU_ONLY_BATCH_ERROR: GCS bucket "${bucket}" is in non-EU location "${meta.location ?? 'unknown'}" (expected EU or europe-*)`,
    )
  }
  gcsBucketLocationCache.set(bucket, loc)
  return loc
}

async function submitVertexEuBatch(ctx: AdapterSubmitContext): Promise<{ externalBatchId: string }> {
  const bucket = (ctx.env['VERTEX_EU_BATCH_BUCKET'] ?? '').trim().replace(/^gs:\/\//, '').replace(/\/+$/, '')
  if (!bucket) {
    throw new BatchValidationError(
      'VERTEX_EU_BATCH_BUCKET_MISSING',
      'VERTEX_EU_BATCH_BUCKET is required for vertex-eu batch jobs',
    )
  }
  const rawLocation = (ctx.env['VERTEX_EU_BATCH_LOCATION'] ?? ctx.env['VERTEX_EU_LOCATION'] ?? 'europe-central2').trim()
  const location = assertVertexEuRegion(rawLocation === 'eu' ? 'europe-central2' : rawLocation)

  const { accessToken, projectId } = await resolveVertexEuAuth({
    env: ctx.env,
    projectRoot: ctx.projectRoot,
    fetchImpl: ctx.fetchImpl,
  })

  if (ctx.euOnly) {
    await verifyGcsBucketEuLocation(bucket, accessToken, ctx.fetchImpl)
  }

  const tmpVertexPath = join(dirname(ctx.absInputPath), `.${ctx.jobId}.vertex-input.jsonl`)
  const ws = createWriteStream(tmpVertexPath, { encoding: 'utf-8' })
  for await (const item of streamCanonicalItems(ctx.absInputPath)) {
    ws.write(toVertexEuBatchLine(item) + '\n')
  }
  await new Promise<void>((res, rej) => {
    ws.on('finish', res)
    ws.on('error', rej)
    ws.end()
  })

  const objectName = `alfred-batch/${ctx.jobId}/input.jsonl`
  const outputPrefix = `alfred-batch/${ctx.jobId}/output/`

  try {
    const fileBytes = readFileSync(tmpVertexPath)
    const uploadResp = await ctx.fetchImpl(
      `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(objectName)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/jsonl',
        },
        body: fileBytes,
      },
    )
    if (!uploadResp.ok) {
      const errText = await uploadResp.text().catch(() => '')
      throw new Error(`Vertex EU GCS upload error ${uploadResp.status}: ${errText.slice(0, 240)}`)
    }

    const host = resolveVertexEuApiHost(location)
    const jobResp = await ctx.fetchImpl(
      `${host}/v1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}/batchPredictionJobs`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          displayName: `alfred-batch-${ctx.jobId}`,
          model: `publishers/google/models/${ctx.model}`,
          inputConfig: {
            instancesFormat: 'jsonl',
            gcsSource: {
              uris: [`gs://${bucket}/${objectName}`],
            },
          },
          outputConfig: {
            predictionsFormat: 'jsonl',
            gcsDestination: {
              outputUriPrefix: `gs://${bucket}/${outputPrefix}`,
            },
          },
        }),
      },
    )
    if (!jobResp.ok) {
      const errText = await jobResp.text().catch(() => '')
      throw new Error(`Vertex EU batchPredictionJobs submit error ${jobResp.status}: ${errText.slice(0, 240)}`)
    }
    const jobData = (await jobResp.json()) as { name?: string }
    if (!jobData.name) throw new Error('Vertex EU batchPredictionJobs returned no job name')
    return { externalBatchId: jobData.name }
  } finally {
    try { unlinkSync(tmpVertexPath) } catch { /* ignore */ }
  }
}

async function pollVertexEuBatch(
  job: BatchJobRecord,
  env: Record<string, string | undefined>,
  projectRoot: string,
  fetchImpl: typeof fetch,
  prices: Record<string, TokenPrice>,
): Promise<AdapterPollResult> {
  const bucket = (env['VERTEX_EU_BATCH_BUCKET'] ?? '').trim().replace(/^gs:\/\//, '').replace(/\/+$/, '')
  const rawLocation = (env['VERTEX_EU_BATCH_LOCATION'] ?? env['VERTEX_EU_LOCATION'] ?? 'europe-central2').trim()
  const location = assertVertexEuRegion(rawLocation === 'eu' ? 'europe-central2' : rawLocation)
  const { accessToken } = await resolveVertexEuAuth({ env, projectRoot, fetchImpl })

  const host = resolveVertexEuApiHost(location)
  const jobName = job.external_batch_id!.replace(/^\/+/, '')
  const resp = await fetchImpl(`${host}/v1/${jobName}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`Vertex EU batch poll error ${resp.status}: ${errText.slice(0, 240)}`)
  }
  const data = (await resp.json()) as {
    state?: string
    error?: { message?: string }
    outputInfo?: { gcsOutputDirectory?: string }
  }
  const state = data.state ?? ''
  if (state === 'JOB_STATE_CANCELLED' || state === 'JOB_STATE_CANCELLING') {
    return { status: 'cancelled' }
  }
  if (state === 'JOB_STATE_FAILED' || state === 'JOB_STATE_EXPIRED') {
    return { status: 'failed', errorMessage: data.error?.message ?? `Vertex EU batch ${state}` }
  }
  if (state !== 'JOB_STATE_SUCCEEDED') {
    return { status: 'running' }
  }

  // Parse output directory prefix (fallback to our known prefix)
  let prefix = `alfred-batch/${job.id}/output/`
  let outBucket = bucket
  const outDir = data.outputInfo?.gcsOutputDirectory
  if (outDir && outDir.startsWith('gs://')) {
    const withoutScheme = outDir.slice('gs://'.length)
    const slashIdx = withoutScheme.indexOf('/')
    if (slashIdx > 0) {
      outBucket = withoutScheme.slice(0, slashIdx)
      prefix = withoutScheme.slice(slashIdx + 1).replace(/^\/+/, '')
      if (prefix && !prefix.endsWith('/')) prefix += '/'
    }
  }

  // List ALL prediction shard files under the GCS output prefix
  const listResp = await fetchImpl(
    `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(outBucket)}/o?prefix=${encodeURIComponent(prefix)}`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  )
  if (!listResp.ok) {
    throw new Error(`Vertex EU GCS list output shards error ${listResp.status}`)
  }
  const listData = (await listResp.json()) as { items?: Array<{ name?: string }> }
  const shards = (listData.items ?? [])
    .map((it) => it.name ?? '')
    .filter((name) => /(?:^|\/)predictions[^/]*\.jsonl$/i.test(name) || name.endsWith('.jsonl'))
    .sort()

  const outputItems: CanonicalBatchOutputItem[] = []
  for (const shardName of shards) {
    const dlResp = await fetchImpl(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(outBucket)}/o/${encodeURIComponent(shardName)}?alt=media`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    )
    if (!dlResp.ok) {
      throw new Error(`Vertex EU GCS shard download error ${dlResp.status} for ${shardName}`)
    }
    const textBody = await dlResp.text()
    for (const line of textBody.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const row = JSON.parse(trimmed) as {
        custom_id?: string
        status?: string
        response?: {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
          usageMetadata?: {
            promptTokenCount?: number
            candidatesTokenCount?: number
            cachedContentTokenCount?: number
          }
        }
      }
      const cid = row.custom_id ?? 'unknown'
      if (row.status && row.status.trim() !== '') {
        outputItems.push({
          custom_id: cid,
          status: 'error',
          error: row.status,
          usage: { input_tokens: 0, output_tokens: 0 },
          cost_usd: 0,
        })
        continue
      }
      const text = (row.response?.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text ?? '')
        .join('\n')
        .trim()
      const u = row.response?.usageMetadata ?? {}
      const cached = u.cachedContentTokenCount ?? 0
      const uncachedInput = Math.max(0, (u.promptTokenCount ?? 0) - cached)
      const usage = {
        input_tokens: uncachedInput,
        output_tokens: u.candidatesTokenCount ?? 0,
        ...(cached > 0 ? { cache_read_input_tokens: cached } : {}),
      }
      const { batchCostUsd } = computeBatchCostBreakdown(job.model, usage, prices)
      outputItems.push({ custom_id: cid, status: 'ok', text, usage, cost_usd: batchCostUsd })
    }
  }

  return { status: 'completed', outputItems }
}

async function cancelVertexEuBatch(
  job: BatchJobRecord,
  env: Record<string, string | undefined>,
  projectRoot: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const rawLocation = (env['VERTEX_EU_BATCH_LOCATION'] ?? env['VERTEX_EU_LOCATION'] ?? 'europe-central2').trim()
  const location = assertVertexEuRegion(rawLocation === 'eu' ? 'europe-central2' : rawLocation)
  const { accessToken } = await resolveVertexEuAuth({ env, projectRoot, fetchImpl })
  const host = resolveVertexEuApiHost(location)
  const jobName = job.external_batch_id!.replace(/^\/+/, '')
  const resp = await fetchImpl(`${host}/v1/${jobName}:cancel`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!resp.ok && resp.status !== 404 && resp.status !== 409) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`Vertex EU batch cancel error ${resp.status}: ${errText.slice(0, 200)}`)
  }
}

// --- 4. OpenAI Batch API Adapter ---

export function toOpenAiBatchLine(item: CanonicalBatchInputItem, model: string): string {
  const messages: Array<{ role: string; content: string }> = []
  if (item.system && item.system.trim()) {
    messages.push({ role: 'system', content: item.system })
  }
  messages.push({ role: 'user', content: item.prompt })
  return JSON.stringify({
    custom_id: item.custom_id,
    method: 'POST',
    url: '/v1/chat/completions',
    body: {
      model,
      messages,
      max_tokens: item.max_tokens ?? 1024,
    },
  })
}

function buildMultipartFormData(
  fields: Record<string, string>,
  fileField: { name: string; filename: string; contentType: string; data: Buffer },
): { body: Buffer; contentType: string } {
  const boundary = `----AlfredBatchBoundary${randomUUID().replace(/-/g, '')}`
  const chunks: Buffer[] = []
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
        'utf-8',
      ),
    )
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fileField.name}"; filename="${fileField.filename}"\r\nContent-Type: ${fileField.contentType}\r\n\r\n`,
      'utf-8',
    ),
  )
  chunks.push(fileField.data)
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8'))
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

async function submitOpenAiBatch(ctx: AdapterSubmitContext): Promise<{ externalBatchId: string }> {
  const apiKey = (ctx.env['OPENAI_API_KEY'] ?? '').trim()
  if (!apiKey) throw new Error('OPENAI_API_KEY is missing')
  const baseUrl = (ctx.env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1').replace(/\/+$/, '')

  const tmpPath = join(dirname(ctx.absInputPath), `.${ctx.jobId}.openai-input.jsonl`)
  const ws = createWriteStream(tmpPath, { encoding: 'utf-8' })
  for await (const item of streamCanonicalItems(ctx.absInputPath)) {
    ws.write(toOpenAiBatchLine(item, ctx.model) + '\n')
  }
  await new Promise<void>((res, rej) => {
    ws.on('finish', res)
    ws.on('error', rej)
    ws.end()
  })

  try {
    const fileData = readFileSync(tmpPath)
    const multipart = buildMultipartFormData(
      { purpose: 'batch' },
      {
        name: 'file',
        filename: `${ctx.jobId}.jsonl`,
        contentType: 'application/jsonl',
        data: fileData,
      },
    )

    const uploadResp = await ctx.fetchImpl(`${baseUrl}/files`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': multipart.contentType,
      },
      body: new Uint8Array(multipart.body),
    })
    if (!uploadResp.ok) {
      const errText = await uploadResp.text().catch(() => '')
      throw new Error(`OpenAI Files upload error ${uploadResp.status}: ${errText.slice(0, 240)}`)
    }
    const uploadData = (await uploadResp.json()) as { id?: string }
    if (!uploadData.id) throw new Error('OpenAI Files API returned no file id')

    const batchResp = await ctx.fetchImpl(`${baseUrl}/batches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input_file_id: uploadData.id,
        endpoint: '/v1/chat/completions',
        completion_window: '24h',
      }),
    })
    if (!batchResp.ok) {
      const errText = await batchResp.text().catch(() => '')
      throw new Error(`OpenAI Batches create error ${batchResp.status}: ${errText.slice(0, 240)}`)
    }
    const batchData = (await batchResp.json()) as { id?: string }
    if (!batchData.id) throw new Error('OpenAI Batches API returned no batch id')
    return { externalBatchId: batchData.id }
  } finally {
    try { unlinkSync(tmpPath) } catch { /* ignore */ }
  }
}

async function pollOpenAiBatch(
  job: BatchJobRecord,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
  prices: Record<string, TokenPrice>,
): Promise<AdapterPollResult> {
  const apiKey = (env['OPENAI_API_KEY'] ?? '').trim()
  const baseUrl = (env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1').replace(/\/+$/, '')

  const resp = await fetchImpl(`${baseUrl}/batches/${encodeURIComponent(job.external_batch_id!)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`OpenAI Batches poll error ${resp.status}: ${errText.slice(0, 240)}`)
  }
  const data = (await resp.json()) as {
    status?: string
    output_file_id?: string | null
    error_file_id?: string | null
    request_counts?: { total?: number; completed?: number; failed?: number }
  }

  const st = data.status ?? ''
  if (st === 'cancelled' || st === 'cancelling') {
    return { status: 'cancelled' }
  }
  if (st === 'validating' || st === 'in_progress' || st === 'finalizing') {
    return {
      status: 'running',
      completedItems: data.request_counts?.completed ?? 0,
      failedItems: data.request_counts?.failed ?? 0,
    }
  }

  const outputItems: CanonicalBatchOutputItem[] = []
  const parseOpenAiLines = (raw: string, forceError: boolean) => {
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const row = JSON.parse(trimmed) as {
        custom_id?: string
        error?: { message?: string; code?: string } | null
        response?: {
          status_code?: number
          body?: {
            choices?: Array<{ message?: { content?: string | null } }>
            usage?: {
              prompt_tokens?: number
              completion_tokens?: number
              prompt_tokens_details?: { cached_tokens?: number }
            }
            error?: { message?: string }
          }
        } | null
      }
      const cid = row.custom_id ?? 'unknown'
      const statusCode = row.response?.status_code ?? 200
      if (forceError || row.error || statusCode >= 400 || row.response?.body?.error) {
        outputItems.push({
          custom_id: cid,
          status: 'error',
          error:
            row.error?.message ??
            row.response?.body?.error?.message ??
            `HTTP ${statusCode}`,
          usage: { input_tokens: 0, output_tokens: 0 },
          cost_usd: 0,
        })
        continue
      }
      const text = row.response?.body?.choices?.[0]?.message?.content ?? ''
      const u = row.response?.body?.usage ?? {}
      const cached = u.prompt_tokens_details?.cached_tokens ?? 0
      const uncachedInput = Math.max(0, (u.prompt_tokens ?? 0) - cached)
      const usage = {
        input_tokens: uncachedInput,
        output_tokens: u.completion_tokens ?? 0,
        ...(cached > 0 ? { cache_read_input_tokens: cached } : {}),
      }
      const { batchCostUsd } = computeBatchCostBreakdown(job.model, usage, prices)
      outputItems.push({ custom_id: cid, status: 'ok', text, usage, cost_usd: batchCostUsd })
    }
  }

  if (data.output_file_id) {
    const outResp = await fetchImpl(
      `${baseUrl}/files/${encodeURIComponent(data.output_file_id)}/content`,
      { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } },
    )
    if (!outResp.ok) throw new Error(`OpenAI output file download error ${outResp.status}`)
    parseOpenAiLines(await outResp.text(), false)
  }

  if (data.error_file_id) {
    const errResp = await fetchImpl(
      `${baseUrl}/files/${encodeURIComponent(data.error_file_id)}/content`,
      { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } },
    )
    if (!errResp.ok) throw new Error(`OpenAI error file download error ${errResp.status}`)
    parseOpenAiLines(await errResp.text(), true)
  }

  if (st === 'failed' && outputItems.length === 0) {
    return { status: 'failed', errorMessage: 'OpenAI batch failed with no output items' }
  }
  if (st === 'expired') {
    const okCount = outputItems.filter((it) => it.status === 'ok').length
    return {
      status: okCount > 0 ? 'completed' : 'failed',
      outputItems,
      errorMessage: okCount === 0 ? 'OpenAI batch expired before completing any items' : undefined,
    }
  }

  return { status: 'completed', outputItems }
}

async function cancelOpenAiBatch(
  job: BatchJobRecord,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
): Promise<void> {
  const apiKey = (env['OPENAI_API_KEY'] ?? '').trim()
  const baseUrl = (env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1').replace(/\/+$/, '')
  const resp = await fetchImpl(
    `${baseUrl}/batches/${encodeURIComponent(job.external_batch_id!)}/cancel`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
    },
  )
  if (!resp.ok && resp.status !== 404 && resp.status !== 409) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`OpenAI Batches cancel error ${resp.status}: ${errText.slice(0, 200)}`)
  }
}

// ============================================================================
// High-level Batch Orchestration: submit, status, list, cancel, poll
// ============================================================================

export interface SubmitBatchJobOptions {
  db: Database.Database
  inputPath: string
  provider?: RequestedBatchProvider
  model?: string
  taskType?: BatchTaskType
  euOnly?: boolean
  agentId?: string
  agentDailyLimitUsd?: number
  globalDailyLimitUsd?: number
  discordChannelId?: string | null
  projectRoot?: string
  env?: Record<string, string | undefined>
  fetchImpl?: typeof fetch
  nowSec?: number
  tokenPrices?: Record<string, TokenPrice>
  maxAnthropicRequests?: number
  maxAnthropicBytes?: number
}

export async function submitBatchJob(opts: SubmitBatchJobOptions): Promise<BatchJobRecord> {
  ensureBatchJobsTable(opts.db)
  const projectRoot = resolve(opts.projectRoot ?? PROJECT_ROOT)
  const env = opts.env ?? { ...readEnvFile(), ...process.env }
  const fetchImpl = opts.fetchImpl ?? fetch
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000)
  const requestedProvider: RequestedBatchProvider = opts.provider ?? 'auto'
  const prices = resolveEffectiveTokenPrices(opts.tokenPrices)

  // 1. Strict path confinement (`batch/` and `store/batch/`)
  const absInputPath = resolveBatchConfinedPath(projectRoot, opts.inputPath, { mustExist: true })
  const relInputPath = relative(projectRoot, absInputPath).replace(/\\/g, '/')

  // 2. Streamed canonical validation, custom_id dedup, and secret-gate scan
  const scan = await validateAndScanCanonicalJsonl(absInputPath, relInputPath)
  const effectiveEuOnly = opts.euOnly === true || scan.anyEuOnly
  const effectiveTaskType = opts.taskType ?? scan.dominantTaskType

  // 3. Resolve provider + ordered fallback chain
  const plan = resolveBatchProvider({
    requestedProvider,
    taskType: effectiveTaskType,
    euOnly: effectiveEuOnly,
    env,
  })

  // 4. Pre-flight cost estimate & Budget / Circuit Breaker gate
  const primaryModel = (opts.model ?? '').trim() || DEFAULT_BATCH_MODELS[plan.primary]
  const est = computeBatchCostBreakdown(
    primaryModel,
    { input_tokens: scan.estimatedInputTokens, output_tokens: scan.estimatedOutputTokens },
    prices,
  )

  const agentId = opts.agentId ?? 'alfred-batch'
  const agentLimit = opts.agentDailyLimitUsd ?? 3.0
  const globalLimit = opts.globalDailyLimitUsd ?? 15.0
  const cbEval = evaluateCircuitBreaker({
    db: opts.db,
    agentId,
    agentDailyLimitUsd: agentLimit,
    globalDailyLimitUsd: globalLimit,
    nowSec,
    tokenPrices: prices,
  })
  if (!cbEval.allowed) {
    throw new BudgetExceededError(cbEval)
  }
  if (cbEval.agentSpendUsd + est.batchCostUsd > cbEval.agentLimitUsd) {
    throw new BudgetExceededError({
      ...cbEval,
      allowed: false,
      code: 'BUDGET_EXCEEDED',
      reason: 'agent_daily_limit',
      discordMessage:
        `⛔ **BUDGET_EXCEEDED (Batch pre-flight)**: A becsült 50%-os Batch költség ($${est.batchCostUsd.toFixed(4)}) ` +
        `a napi ágens-költéssel ($${cbEval.agentSpendUsd.toFixed(4)}) túllépné a napi keretet ($${cbEval.agentLimitUsd.toFixed(2)}).`,
    })
  }
  if (cbEval.globalSpendUsd + est.batchCostUsd > cbEval.globalLimitUsd) {
    throw new BudgetExceededError({
      ...cbEval,
      allowed: false,
      code: 'BUDGET_EXCEEDED',
      reason: 'global_daily_limit',
      discordMessage:
        `⛔ **BUDGET_EXCEEDED (Batch pre-flight)**: A becsült 50%-os Batch költség ($${est.batchCostUsd.toFixed(4)}) ` +
        `a globális napi költéssel ($${cbEval.globalSpendUsd.toFixed(4)}) túllépné a globális keretet ($${cbEval.globalLimitUsd.toFixed(2)}).`,
    })
  }

  // Also consult CostOps agent-budgets helper (monthly sanity check)
  const monthWinStart = Math.floor(Date.UTC(new Date(nowSec * 1000).getUTCFullYear(), new Date(nowSec * 1000).getUTCMonth(), 1) / 1000)
  const monthWinEnd = Math.floor(Date.UTC(new Date(nowSec * 1000).getUTCFullYear(), new Date(nowSec * 1000).getUTCMonth() + 1, 1) / 1000)
  agentSpend(opts.db, agentId, monthWinStart, monthWinEnd, prices)
  evaluateAgentBudgets(opts.db, { budgets: [], token_prices: prices } as never, nowSec)

  // 5. Job-level worksource-queue (`store/batch/worksource-queue/pending/<jobId>.json`) + heavy-job-hold
  const jobId = `batch_${nowSec}_${randomUUID().slice(0, 8)}`
  const queueRoot = batchWorksourceQueueRoot(projectRoot)
  enqueueWorksourceItemAt(queueRoot, jobId, relInputPath, {
    requestedProvider,
    taskType: effectiveTaskType,
    euOnly: effectiveEuOnly,
    totalItems: scan.totalItems,
  })

  return withBatchHeavyJobHold(
    projectRoot,
    jobId,
    async () => {
      let chosenProvider: BatchProviderName | null = null
      let chosenModel = primaryModel
      let externalBatchId: string | null = null
      const attemptErrors: string[] = []

      for (const candidate of plan.candidates) {
        const candidateModel =
          candidate === plan.primary && (opts.model ?? '').trim()
            ? opts.model!.trim()
            : DEFAULT_BATCH_MODELS[candidate]
        const adapterCtx: AdapterSubmitContext = {
          jobId,
          model: candidateModel,
          absInputPath,
          scan,
          euOnly: effectiveEuOnly,
          env,
          projectRoot,
          fetchImpl,
          maxAnthropicRequests: opts.maxAnthropicRequests,
          maxAnthropicBytes: opts.maxAnthropicBytes,
        }
        try {
          if (candidate === 'anthropic') {
            externalBatchId = (await submitAnthropicBatch(adapterCtx)).externalBatchId
          } else if (candidate === 'gemini') {
            externalBatchId = (await submitGeminiBatch(adapterCtx)).externalBatchId
          } else if (candidate === 'vertex-eu') {
            externalBatchId = (await submitVertexEuBatch(adapterCtx)).externalBatchId
          } else {
            externalBatchId = (await submitOpenAiBatch(adapterCtx)).externalBatchId
          }
          chosenProvider = candidate
          chosenModel = candidateModel
          break
        } catch (err) {
          // Payload too large or GDPR EU-only violation should NOT silently fall back when euOnly
          if (err instanceof BatchEuOnlyError) {
            transitionBatchWorksourceStage(queueRoot, jobId, 'done')
            throw err
          }
          const msg = err instanceof Error ? err.message : String(err)
          attemptErrors.push(`${candidate}: ${msg}`)
          logger.warn({ jobId, candidate, err: msg }, 'Batch provider submission failed; trying next fallback')
        }
      }

      if (!chosenProvider || !externalBatchId) {
        transitionBatchWorksourceStage(queueRoot, jobId, 'done')
        throw new Error(`All configured Batch providers failed: ${attemptErrors.join(' | ')}`)
      }

      const finalEst = computeBatchCostBreakdown(
        chosenModel,
        { input_tokens: scan.estimatedInputTokens, output_tokens: scan.estimatedOutputTokens },
        prices,
      )
      const outputRelPath = `store/batch/${jobId}.output.jsonl`

      opts.db
        .prepare(
          `INSERT INTO batch_jobs (
            id, provider, requested_provider, model, status, external_batch_id,
            input_path, output_path, total_items, completed_items, failed_items,
            estimated_cost_usd, actual_cost_usd, saved_cost_usd, cost_recorded,
            discord_channel_id, error_message, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'submitted', ?, ?, ?, ?, 0, 0, ?, NULL, ?, 0, ?, NULL, ?, ?)`,
        )
        .run(
          jobId,
          chosenProvider,
          requestedProvider,
          chosenModel,
          externalBatchId,
          relInputPath,
          outputRelPath,
          scan.totalItems,
          finalEst.batchCostUsd,
          finalEst.savedCostUsd,
          opts.discordChannelId ?? null,
          nowSec,
          nowSec,
        )

      transitionBatchWorksourceStage(queueRoot, jobId, 'active')
      return getBatchJobById(opts.db, jobId)!
    },
    nowSec * 1000,
  )
}

export function getBatchJobById(db: Database.Database, jobId: string): BatchJobRecord | null {
  ensureBatchJobsTable(db)
  const row = db.prepare(`SELECT * FROM batch_jobs WHERE id = ? LIMIT 1`).get(jobId) as
    | BatchJobRecord
    | undefined
  return row ?? null
}

export function listBatchJobs(
  db: Database.Database,
  opts: { status?: string; limit?: number } = {},
): BatchJobRecord[] {
  ensureBatchJobsTable(db)
  const limit = Math.max(1, Math.min(100, Math.floor(opts.limit ?? 20)))
  if (opts.status && opts.status.trim()) {
    return db
      .prepare(`SELECT * FROM batch_jobs WHERE status = ? ORDER BY created_at DESC LIMIT ?`)
      .all(opts.status.trim(), limit) as BatchJobRecord[]
  }
  return db
    .prepare(`SELECT * FROM batch_jobs ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as BatchJobRecord[]
}

export async function cancelBatchJob(opts: {
  db: Database.Database
  batchId: string
  projectRoot?: string
  env?: Record<string, string | undefined>
  fetchImpl?: typeof fetch
  nowSec?: number
}): Promise<BatchJobRecord> {
  ensureBatchJobsTable(opts.db)
  const job = getBatchJobById(opts.db, opts.batchId)
  if (!job) {
    throw new BatchValidationError('BATCH_NOT_FOUND', `Batch job not found: ${opts.batchId}`)
  }
  if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
    return job
  }

  const env = opts.env ?? { ...readEnvFile(), ...process.env }
  const fetchImpl = opts.fetchImpl ?? fetch
  const projectRoot = resolve(opts.projectRoot ?? PROJECT_ROOT)
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000)

  if (job.external_batch_id) {
    if (job.provider === 'anthropic') {
      await cancelAnthropicBatch(job, env, fetchImpl)
    } else if (job.provider === 'gemini') {
      await cancelGeminiBatch(job, env, fetchImpl)
    } else if (job.provider === 'vertex-eu') {
      await cancelVertexEuBatch(job, env, projectRoot, fetchImpl)
    } else if (job.provider === 'openai') {
      await cancelOpenAiBatch(job, env, fetchImpl)
    }
  }

  opts.db
    .prepare(`UPDATE batch_jobs SET status = 'cancelled', updated_at = ? WHERE id = ?`)
    .run(nowSec, job.id)

  transitionBatchWorksourceStage(batchWorksourceQueueRoot(projectRoot), job.id, 'done')
  return getBatchJobById(opts.db, job.id)!
}

/**
 * Builds the internal programmatic QA sampling prompt (3–5 items wrapped in `wrapUntrusted`
 * and combined via `composeBatchInjection`) so `alfred-qa` can review completed batch output
 * without triggering a Discord bot-to-bot loop.
 */
export function buildBatchQaSamplePrompt(
  job: BatchJobRecord,
  outputItems: readonly CanonicalBatchOutputItem[],
  maxSamples = 5,
): string {
  const sampleCount = Math.min(maxSamples, outputItems.length)
  const selected = outputItems.slice(0, sampleCount)
  const remaining = Math.max(0, outputItems.length - selected.length)

  const envelopes: BatchInjectItem[] = selected.map((it, idx) => {
    const payload =
      it.status === 'ok'
        ? `custom_id=${it.custom_id} | status=ok | tokens=${it.usage.input_tokens}/${it.usage.output_tokens}\n${(it.text ?? '').slice(0, 1200)}`
        : `custom_id=${it.custom_id} | status=error | error=${it.error ?? 'unknown'}`
    return {
      prefix: `[Mintaelem #${idx + 1}/${sampleCount} — batch=${job.id}, provider=${job.provider}, model=${job.model}]: `,
      wrapped: wrapUntrusted(`batch-output:${job.id}:${it.custom_id}`, payload),
    }
  })

  const injected = composeBatchInjection(envelopes, remaining)
  return (
    `Kérlek végezz rövid, pontokba szedett mintavételes minőségellenőrzést (QA) a(z) \`${job.id}\` ` +
    `(${job.provider} / ${job.model}) Batch köteg ${sampleCount} mintaelemén! ` +
    `Ellenőrizd a formátumot, teljességet, esetleges hibákat vagy hallucinációkat, és adj egy 2-3 soros tömör ítéletet (OK / FIGYELEM / HIBA).\n\n` +
    injected
  )
}

export interface PollBatchJobOptions {
  db: Database.Database
  batchId: string
  projectRoot?: string
  env?: Record<string, string | undefined>
  runtimeEnv?: AlfredRuntimeEnv
  agentsConfig?: AlfredAgentsConfig | null
  sendToDiscord?: DiscordSendFn
  fetchImpl?: typeof fetch
  nowSec?: number
  tokenPrices?: Record<string, TokenPrice>
  qaRunnerFn?: (qaAgent: AlfredAgentDefinition, prompt: string) => Promise<string | null>
}

export interface PollBatchJobResult {
  job: BatchJobRecord
  transitioned: boolean
  skippedInFlight?: boolean
  qaSummary?: string | null
  discordNotified?: boolean
}

function resolveBatchDiscordChannelId(
  job: BatchJobRecord,
  agentsConfig: AlfredAgentsConfig | null | undefined,
  env: Record<string, string | undefined>,
): string | null {
  if (job.discord_channel_id && job.discord_channel_id.trim()) {
    return job.discord_channel_id.trim()
  }
  const batchAgent = agentsConfig?.agents.find((a) => a.id === 'alfred-batch')
  const fromAgent = batchAgent?.discordChannelId?.trim() ?? ''
  if (fromAgent && !fromAgent.startsWith('${')) return fromAgent
  const fromEnv = (env['DISCORD_CHANNEL_ALFRED_BATCH'] ?? '').trim()
  if (fromEnv && !fromEnv.startsWith('${')) return fromEnv
  return null
}

/**
 * Polls a single pending batch job with:
 * - `inFlightPollIds` concurrency lock
 * - Atomic SQLite `status = 'downloading'` (`changes === 1`) before writing output
 * - Immediate `downloading` -> `running` revert on transient download/translation errors
 * - Atomic `db.transaction()` for `cost_recorded = 0 -> 1` + `recordModelTokenUsage` (0.5x batch pricing)
 * - Non-fatal post-transaction internal programmatic `alfred-qa` sampling + `#alfred-batch` Discord notification
 */
export async function pollBatchJob(opts: PollBatchJobOptions): Promise<PollBatchJobResult> {
  ensureBatchJobsTable(opts.db)
  const existing = getBatchJobById(opts.db, opts.batchId)
  if (!existing) {
    throw new BatchValidationError('BATCH_NOT_FOUND', `Batch job not found: ${opts.batchId}`)
  }
  if (
    existing.status === 'completed' ||
    existing.status === 'failed' ||
    existing.status === 'cancelled'
  ) {
    return { job: existing, transitioned: false }
  }
  if (inFlightPollIds.has(existing.id)) {
    return { job: existing, transitioned: false, skippedInFlight: true }
  }

  inFlightPollIds.add(existing.id)
  const projectRoot = resolve(opts.projectRoot ?? PROJECT_ROOT)
  const env = opts.env ?? { ...readEnvFile(), ...process.env }
  const fetchImpl = opts.fetchImpl ?? fetch
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000)
  const prices = resolveEffectiveTokenPrices(opts.tokenPrices)
  const queueRoot = batchWorksourceQueueRoot(projectRoot)

  try {
    let pollRes: AdapterPollResult
    if (existing.provider === 'anthropic') {
      pollRes = await pollAnthropicBatch(existing, env, fetchImpl, prices)
    } else if (existing.provider === 'gemini') {
      pollRes = await pollGeminiBatch(existing, env, fetchImpl, prices)
    } else if (existing.provider === 'vertex-eu') {
      pollRes = await pollVertexEuBatch(existing, env, projectRoot, fetchImpl, prices)
    } else {
      pollRes = await pollOpenAiBatch(existing, env, fetchImpl, prices)
    }

    if (pollRes.status === 'running') {
      opts.db
        .prepare(
          `UPDATE batch_jobs
           SET status = 'running', completed_items = ?, failed_items = ?, updated_at = ?
           WHERE id = ? AND status IN ('queued', 'submitted', 'running')`,
        )
        .run(
          pollRes.completedItems ?? existing.completed_items,
          pollRes.failedItems ?? existing.failed_items,
          nowSec,
          existing.id,
        )
      return { job: getBatchJobById(opts.db, existing.id)!, transitioned: false }
    }

    // Acquire atomic DB lock: transition -> 'downloading'
    const lockRes = opts.db
      .prepare(
        `UPDATE batch_jobs
         SET status = 'downloading', updated_at = ?
         WHERE id = ? AND status IN ('queued', 'submitted', 'running')`,
      )
      .run(nowSec, existing.id)

    if (Number(lockRes.changes ?? 0) !== 1) {
      return { job: getBatchJobById(opts.db, existing.id)!, transitioned: false, skippedInFlight: true }
    }

    let outputItems: CanonicalBatchOutputItem[] = []
    let finalStatus: BatchJobStatus = pollRes.status
    let completedCount = existing.completed_items
    let failedCount = existing.failed_items
    let totalActualCostUsd = 0
    let totalSavedCostUsd = 0
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let totalCacheReadTokens = 0
    let totalCacheCreateTokens = 0

    try {
      await withBatchHeavyJobHold(
        projectRoot,
        existing.id,
        async () => {
          outputItems = pollRes.outputItems ?? []
          if (outputItems.length > 0 && existing.output_path) {
            const absOut = resolveBatchConfinedPath(projectRoot, existing.output_path)
            mkdirSync(dirname(absOut), { recursive: true })
            const ws = createWriteStream(absOut, { encoding: 'utf-8' })
            for (const item of outputItems) {
              ws.write(JSON.stringify(item) + '\n')
            }
            await new Promise<void>((res, rej) => {
              ws.on('finish', res)
              ws.on('error', rej)
              ws.end()
            })
          }

          if (outputItems.length > 0) {
            completedCount = outputItems.filter((it) => it.status === 'ok').length
            failedCount = outputItems.filter((it) => it.status === 'error').length
            for (const it of outputItems) {
              totalInputTokens += it.usage.input_tokens || 0
              totalOutputTokens += it.usage.output_tokens || 0
              totalCacheReadTokens += it.usage.cache_read_input_tokens || 0
              totalCacheCreateTokens += it.usage.cache_creation_input_tokens || 0
            }
            const agg = computeBatchCostBreakdown(
              existing.model,
              {
                input_tokens: totalInputTokens,
                output_tokens: totalOutputTokens,
                cache_creation_input_tokens: totalCacheCreateTokens,
                cache_read_input_tokens: totalCacheReadTokens,
              },
              prices,
            )
            totalActualCostUsd = agg.batchCostUsd
            totalSavedCostUsd = agg.savedCostUsd
          }
        },
        nowSec * 1000,
      )
    } catch (downloadErr) {
      // Transient error during download/write: immediately revert `downloading` -> `running`
      opts.db
        .prepare(`UPDATE batch_jobs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'downloading'`)
        .run(Math.floor(Date.now() / 1000), existing.id)
      throw downloadErr
    }

    // Atomic SQLite transaction: mark final status + cost_recorded = 0 -> 1 + token_usage (0.5x batch prefix)
    let recordedNow = false
    const commitFinal = opts.db.transaction(() => {
      const upd = opts.db
        .prepare(
          `UPDATE batch_jobs
           SET status = ?,
               completed_items = ?,
               failed_items = ?,
               actual_cost_usd = ?,
               saved_cost_usd = ?,
               cost_recorded = 1,
               error_message = ?,
               updated_at = ?
           WHERE id = ? AND cost_recorded = 0`,
        )
        .run(
          finalStatus,
          completedCount,
          failedCount,
          totalActualCostUsd,
          totalSavedCostUsd,
          pollRes.errorMessage ?? null,
          nowSec,
          existing.id,
        )
      if (Number(upd.changes ?? 0) === 1) {
        recordedNow = true
        if (totalInputTokens > 0 || totalOutputTokens > 0 || totalCacheReadTokens > 0 || totalCacheCreateTokens > 0) {
          recordModelTokenUsage({
            db: opts.db,
            agentId: 'alfred-batch',
            sessionId: `batch:${existing.id}`,
            model: `batch:${existing.model}`,
            provider: existing.provider,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            cacheReadTokens: totalCacheReadTokens,
            cacheCreationTokens: totalCacheCreateTokens,
            contentPreview: `Batch ${existing.id} (${completedCount}/${existing.total_items} ok)`,
            toolName: 'batch',
            timestampSec: nowSec,
          })
        }
      }
    })
    commitFinal()

    transitionBatchWorksourceStage(queueRoot, existing.id, 'done')
    const updatedJob = getBatchJobById(opts.db, existing.id)!

    // Post-transaction non-fatal side effects: internal programmatic `alfred-qa` sampling + `#alfred-batch` Discord notification
    let qaSummary: string | null = null
    let discordNotified = false

    if (recordedNow && finalStatus === 'completed' && outputItems.length > 0) {
      try {
        const qaAgent = opts.agentsConfig?.agents.find((a) => a.id === 'alfred-qa')
        if (qaAgent) {
          const qaPrompt = buildBatchQaSamplePrompt(updatedJob, outputItems, 5)
          if (opts.qaRunnerFn) {
            qaSummary = await opts.qaRunnerFn(qaAgent, qaPrompt)
          } else {
            const qaOutcome = await runHybridAgentTurn({
              db: opts.db,
              agent: qaAgent,
              globalDailyBudgetUsd: opts.agentsConfig?.global.dailyBudgetUsd ?? 15.0,
              userMessage: qaPrompt,
              conversationHistory: [],
              sessionId: `batch-qa:${updatedJob.id}`,
              chatId: 'internal-batch-qa',
              env,
              fetchImpl,
              nowSec,
            })
            if (qaOutcome.ok) {
              qaSummary = qaOutcome.replyText.trim().slice(0, 600)
            }
          }
        }
      } catch (qaErr) {
        logger.warn({ batchId: updatedJob.id, err: qaErr }, 'Internal alfred-qa batch sampling failed (non-fatal)')
      }
    }

    if (recordedNow && opts.sendToDiscord) {
      try {
        const channelId = resolveBatchDiscordChannelId(updatedJob, opts.agentsConfig, env)
        if (channelId) {
          const spent = updatedJob.actual_cost_usd ?? updatedJob.estimated_cost_usd
          const saved = updatedJob.saved_cost_usd
          const lines = [
            finalStatus === 'completed'
              ? `✅ **Batch köteg elkészült:** \`${updatedJob.id}\``
              : `⚠️ **Batch köteg lezárult (${finalStatus}):** \`${updatedJob.id}\``,
            `• Szolgáltató: \`${updatedJob.provider}\` (kérve: \`${updatedJob.requested_provider}\`) · Modell: \`${updatedJob.model}\``,
            `• Elemek: **${updatedJob.completed_items} / ${updatedJob.total_items}** sikeres${updatedJob.failed_items > 0 ? ` (${updatedJob.failed_items} hibás)` : ''}`,
            `• Költség (50% Batch ár): **$${spent.toFixed(4)}** · Megtakarítás: **$${saved.toFixed(4)}**`,
            ...(updatedJob.output_path ? [`• Kimenet: \`${updatedJob.output_path}\``] : []),
            ...(qaSummary ? [`• **Alfred QA mintavétel:** ${qaSummary}`] : []),
          ]
          const rawMsg = lines.join('\n')
          const finalMsg = opts.runtimeEnv ? prefixTestReply(rawMsg, opts.runtimeEnv) : rawMsg
          await opts.sendToDiscord(channelId, finalMsg)
          discordNotified = true
        }
      } catch (notifyErr) {
        logger.warn({ batchId: updatedJob.id, err: notifyErr }, 'Batch Discord notification failed (non-fatal)')
      }
    }

    return { job: updatedJob, transitioned: recordedNow, qaSummary, discordNotified }
  } finally {
    inFlightPollIds.delete(existing.id)
  }
}

export interface PollPendingBatchesOptions {
  db: Database.Database
  projectRoot?: string
  env?: Record<string, string | undefined>
  runtimeEnv?: AlfredRuntimeEnv
  agentsConfig?: AlfredAgentsConfig | null
  sendToDiscord?: DiscordSendFn
  fetchImpl?: typeof fetch
  nowSec?: number
  tokenPrices?: Record<string, TokenPrice>
  qaRunnerFn?: (qaAgent: AlfredAgentDefinition, prompt: string) => Promise<string | null>
}

export async function pollPendingBatches(opts: PollPendingBatchesOptions): Promise<{
  polled: number
  completed: number
  failed: number
  errors: Array<{ batchId: string; error: string }>
}> {
  ensureBatchJobsTable(opts.db)
  const pending = opts.db
    .prepare(
      `SELECT id FROM batch_jobs WHERE status IN ('queued', 'submitted', 'running') ORDER BY updated_at ASC LIMIT 25`,
    )
    .all() as Array<{ id: string }>

  let polled = 0
  let completed = 0
  let failed = 0
  const errors: Array<{ batchId: string; error: string }> = []

  for (const row of pending) {
    try {
      const res = await pollBatchJob({
        ...opts,
        batchId: row.id,
      })
      if (!res.skippedInFlight) polled += 1
      if (res.transitioned && res.job.status === 'completed') completed += 1
      if (res.transitioned && res.job.status === 'failed') failed += 1
    } catch (err) {
      errors.push({
        batchId: row.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return { polled, completed, failed, errors }
}

export interface BatchProviderSummary {
  provider: BatchProviderName
  configured: boolean
  batchCount: number
  completedItems: number
  spentUsd: number
  savedUsd: number
  baselineUsd: number
}

export interface AdminBatchesOverview {
  summary: {
    totalBatches: number
    activeBatches: number
    totalItems: number
    totalSpentUsd: number
    totalSavedUsd: number
    totalBaselineUsd: number
  }
  byProvider: BatchProviderSummary[]
  recentJobs: BatchJobRecord[]
}

export function getAdminBatchesOverview(
  db: Database.Database,
  env: Record<string, string | undefined>,
): AdminBatchesOverview {
  ensureBatchJobsTable(db)
  const allRows = db
    .prepare(`SELECT * FROM batch_jobs ORDER BY created_at DESC`)
    .all() as BatchJobRecord[]

  const byProvMap = new Map<BatchProviderName, BatchProviderSummary>()
  for (const p of BATCH_PROVIDERS) {
    byProvMap.set(p, {
      provider: p,
      configured: isBatchProviderConfigured(p, env),
      batchCount: 0,
      completedItems: 0,
      spentUsd: 0,
      savedUsd: 0,
      baselineUsd: 0,
    })
  }

  let totalBatches = 0
  let activeBatches = 0
  let totalItems = 0
  let totalSpentUsd = 0
  let totalSavedUsd = 0

  for (const row of allRows) {
    totalBatches += 1
    if (
      row.status === 'queued' ||
      row.status === 'submitted' ||
      row.status === 'running' ||
      row.status === 'downloading'
    ) {
      activeBatches += 1
    }
    const spent = row.actual_cost_usd !== null && row.actual_cost_usd !== undefined
      ? Number(row.actual_cost_usd)
      : Number(row.estimated_cost_usd ?? 0)
    const saved = Number(row.saved_cost_usd ?? 0)
    const completed = Number(row.completed_items ?? 0)

    totalItems += completed
    totalSpentUsd += spent
    totalSavedUsd += saved

    const entry = byProvMap.get(row.provider)
    if (entry) {
      entry.batchCount += 1
      entry.completedItems += completed
      entry.spentUsd += spent
      entry.savedUsd += saved
      entry.baselineUsd += spent + saved
    }
  }

  return {
    summary: {
      totalBatches,
      activeBatches,
      totalItems,
      totalSpentUsd,
      totalSavedUsd,
      totalBaselineUsd: totalSpentUsd + totalSavedUsd,
    },
    byProvider: BATCH_PROVIDERS.map((p) => byProvMap.get(p)!),
    recentJobs: allRows.slice(0, 15),
  }
}
