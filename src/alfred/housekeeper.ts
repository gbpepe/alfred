import { execFile } from 'node:child_process'
import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import Database from 'better-sqlite3'
import {
  checkpointAndCompact,
  pruneAgentMessages,
  pruneConversationLog,
  pruneOtelSpans,
  pruneToolCallLogRetention,
} from '../db.js'
import { runLogRotationSweep } from '../web/log-rotation.js'

const execFileAsync = promisify(execFile)

const VACUUM_MIN_FREE_PAGES = 1000
const VACUUM_FREE_RATIO = 0.2

export interface WalCheckpointResult {
  busy: number
  logFrames: number
  checkpointedFrames: number
  walBytesBefore: number
  walBytesAfter: number
  walReclaimedBytes: number
  vacuumed: boolean
  freePagesBefore: number
  prunedDbRows: number
}

export interface HousekeepingResult {
  executedAt: string
  retentionDays: number
  walCheckpoint: WalCheckpointResult
  rotatedAppLogs: string[]
  deletedBatchFiles: string[]
  deletedLogFiles: string[]
  deletedTempFiles: string[]
  deletedFilesCount: number
  reclaimedArtifactsBytes: number
  npmCacheCleaned: boolean
  npmCacheOutput?: string
  totalReclaimedBytes: number
}

export type NpmCacheCleanRunner = (env: Record<string, string | undefined>) => Promise<string>

async function defaultNpmCacheCleanRunner(env: Record<string, string | undefined>): Promise<string> {
  const { stdout, stderr } = await execFileAsync('npm', ['cache', 'clean', '--force'], {
    timeout: 30_000,
    env: { ...process.env, ...env } as NodeJS.ProcessEnv,
  })
  return `${stdout ?? ''}\n${stderr ?? ''}`.trim()
}

export function resolveArtifactRetentionDays(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env['ALFRED_ARTIFACT_RETENTION_DAYS']?.trim()
  if (!raw) return 30
  const n = Number(raw)
  if (!Number.isFinite(n)) return 30
  return Math.max(1, Math.min(3650, Math.round(n)))
}

function getFileSizeSafe(filePath: string): number {
  try {
    if (!existsSync(filePath)) return 0
    return statSync(filePath).size
  } catch {
    return 0
  }
}

function resolveDatabaseFilePath(db: Database.Database, explicitDbPath?: string): string | null {
  if (explicitDbPath && explicitDbPath !== ':memory:') {
    return resolve(explicitDbPath)
  }
  const dbName = typeof db.name === 'string' ? db.name.trim() : ''
  if (!dbName || dbName === ':memory:' || dbName === '') return null
  return resolve(dbName)
}

/**
 * Executes `PRAGMA wal_checkpoint(TRUNCATE);` on the SQLite database (and any optional extra SQLite DB paths)
 * so `store/alfred*.db-wal` does not grow unbounded.
 */
export function checkpointSqliteWal(
  db?: Database.Database | null,
  explicitDbPath?: string,
  extraDbPaths: readonly string[] = [],
): WalCheckpointResult {
  let totalBusy = 0
  let totalLogFrames = 0
  let totalCheckpointedFrames = 0
  let totalWalBefore = 0
  let totalWalAfter = 0
  let anyVacuumed = false
  let maxFreePagesBefore = 0
  let prunedDbRows = 0

  // Invoke Marveen's table retention prunes + checkpointAndCompact() on the global db handle when initialized
  try {
    prunedDbRows += pruneConversationLog()
    prunedDbRows += pruneOtelSpans()
    prunedDbRows += pruneAgentMessages()
    prunedDbRows += pruneToolCallLogRetention()
    const globalCompact = checkpointAndCompact()
    if (globalCompact.vacuumed) anyVacuumed = true
    maxFreePagesBefore = Math.max(maxFreePagesBefore, globalCompact.freePagesBefore)
  } catch {
    // Global db in src/db.ts may not be initialized or may lack optional Marveen tables in minimal unit tests
  }

  const checkpointSingleHandle = (handle: Database.Database, dbPathHint?: string) => {
    const resolvedDb = resolveDatabaseFilePath(handle, dbPathHint)
    const walPath = resolvedDb ? `${resolvedDb}-wal` : null
    const before = walPath ? getFileSizeSafe(walPath) : 0
    totalWalBefore += before

    try {
      const rows = handle.pragma('wal_checkpoint(TRUNCATE)') as Array<{
        busy?: number
        log?: number
        checkpointed?: number
      }>
      const first = rows?.[0]
      const busy = Number(first?.busy ?? 0)
      if (first) {
        totalBusy += busy
        totalLogFrames += Number(first.log ?? 0)
        totalCheckpointedFrames += Number(first.checkpointed ?? 0)
      }

      const freelistPages = Number(handle.pragma('freelist_count', { simple: true }) ?? 0)
      const pageCount = Number(handle.pragma('page_count', { simple: true }) ?? 0)
      maxFreePagesBefore = Math.max(maxFreePagesBefore, freelistPages)
      if (
        busy === 0 &&
        pageCount > 0 &&
        freelistPages >= VACUUM_MIN_FREE_PAGES &&
        freelistPages / pageCount >= VACUUM_FREE_RATIO
      ) {
        handle.exec('VACUUM')
        handle.pragma('wal_checkpoint(TRUNCATE)')
        anyVacuumed = true
      }
    } catch {
      // ignore if database is in-memory or busy
    }

    const after = walPath ? getFileSizeSafe(walPath) : 0
    totalWalAfter += after
  }

  const visitedPaths = new Set<string>()
  if (db) {
    const primaryPath = resolveDatabaseFilePath(db, explicitDbPath)
    if (primaryPath) visitedPaths.add(primaryPath)
    checkpointSingleHandle(db, primaryPath ?? undefined)
  }

  for (const extraPath of extraDbPaths) {
    if (!extraPath || extraPath === ':memory:') continue
    const abs = resolve(extraPath)
    if (visitedPaths.has(abs) || !existsSync(abs)) continue
    visitedPaths.add(abs)
    let extraDb: Database.Database | null = null
    try {
      extraDb = new Database(abs, { fileMustExist: true })
      checkpointSingleHandle(extraDb, abs)
    } catch {
      // ignore locked or inaccessible secondary DB
    } finally {
      try {
        extraDb?.close()
      } catch {
        // ignore close error
      }
    }
  }

  return {
    busy: totalBusy,
    logFrames: totalLogFrames,
    checkpointedFrames: totalCheckpointedFrames,
    walBytesBefore: totalWalBefore,
    walBytesAfter: totalWalAfter,
    walReclaimedBytes: Math.max(0, totalWalBefore - totalWalAfter),
    vacuumed: anyVacuumed,
    freePagesBefore: maxFreePagesBefore,
    prunedDbRows,
  }
}

export interface BatchTablesMetadata {
  hasBatchJobsTable: boolean
  activeIdentifiers: Set<string>
  closedIdentifiers: Set<string>
}

/**
 * Safeguard: checks `sqlite_master` first to verify whether `batch_jobs` exists
 * (since `batch_jobs` is introduced in the upcoming Batch subsystem).
 * Never throws an SQL error if `batch_jobs` does not exist yet.
 */
export function inspectBatchJobsTable(db?: Database.Database | null): BatchTablesMetadata {
  const activeIdentifiers = new Set<string>()
  const closedIdentifiers = new Set<string>()
  if (!db) {
    return { hasBatchJobsTable: false, activeIdentifiers, closedIdentifiers }
  }

  try {
    const tableRow = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'batch_jobs' LIMIT 1`,
      )
      .get() as { name?: string } | undefined

    if (!tableRow || tableRow.name !== 'batch_jobs') {
      return { hasBatchJobsTable: false, activeIdentifiers, closedIdentifiers }
    }

    const cols = db.prepare(`PRAGMA table_info(batch_jobs)`).all() as Array<{ name: string }>
    const colNames = new Set(cols.map((c) => c.name))
    if (!colNames.has('status')) {
      return { hasBatchJobsTable: true, activeIdentifiers, closedIdentifiers }
    }

    const selectCols = ['id', 'job_id', 'batch_id', 'input_path', 'output_path', 'artifact_path'].filter(
      (c) => colNames.has(c),
    )
    const sql = `SELECT status${selectCols.length > 0 ? ', ' + selectCols.join(', ') : ''} FROM batch_jobs`
    const rows = db.prepare(sql).all() as Array<Record<string, unknown>>

    for (const row of rows) {
      const status = String(row['status'] ?? '').trim().toLowerCase()
      const isClosed = status === 'completed' || status === 'failed' || status === 'cancelled'
      const targetSet = isClosed ? closedIdentifiers : activeIdentifiers

      for (const col of selectCols) {
        const val = row[col]
        if (typeof val === 'string' && val.trim()) {
          const trimmed = val.trim()
          targetSet.add(trimmed)
          targetSet.add(basename(trimmed))
        } else if (typeof val === 'number' && Number.isFinite(val)) {
          targetSet.add(String(val))
        }
      }
    }

    return { hasBatchJobsTable: true, activeIdentifiers, closedIdentifiers }
  } catch {
    return { hasBatchJobsTable: false, activeIdentifiers, closedIdentifiers }
  }
}

const PROTECTED_EXACT_FILENAMES = new Set<string>([
  '.env',
  '.env.example',
  '.env.test',
  '.env.ports',
  '.env.bak',
  '.dashboard-token',
  '.last-good-prod-commit',
  '.claude-oauth-token',
  '.vault-key',
  '.vault-key.migrated',
  'vertex-eu-sa.json',
  'federation.json',
  'model-catalog.json',
  'costops-config.json',
  'costops-config.json.bak',
  'verified-recipients.json',
  'meta-graph-pause.json',
  'agents.json',
  'soul.md',
  'claude.md',
])

/**
 * Matches atomic-write temporary `.env.<pid>.<ts>.<hex>.tmp` files so they can be cleaned up when stale,
 * while all real `.env` and named `.env.*` files remain strictly protected.
 */
const STALE_ENV_ATOMIC_TMP_RE = /^\.env\.\d+\.\d+\.[0-9a-f]+\.tmp$/i

export function isProtectedHousekeepingPath(
  filePath: string,
  activeIdentifiers: ReadonlySet<string> = new Set(),
): boolean {
  const norm = filePath.replace(/\\/g, '/')
  const base = basename(norm)
  const lowerBase = base.toLowerCase()

  if (PROTECTED_EXACT_FILENAMES.has(lowerBase)) {
    return true
  }

  // Protect all SQLite database and journal/WAL/SHM files
  if (/\.db(?:-(?:wal|shm|journal))?$/i.test(lowerBase) || /\.sqlite3?(?:-(?:wal|shm|journal))?$/i.test(lowerBase)) {
    return true
  }

  // Protect any .env* file EXCEPT stale atomic-write temp files (.env.<pid>.<ts>.<hex>.tmp)
  if (lowerBase.startsWith('.env') && !STALE_ENV_ATOMIC_TMP_RE.test(base)) {
    return true
  }

  // Protect any credential / token / key files
  if (/(?:credential|oauth|token|secret|sa\.json)/i.test(lowerBase) && !lowerBase.endsWith('.tmp')) {
    return true
  }

  // Protect any file associated with an active (non-closed) batch job
  for (const activeId of activeIdentifiers) {
    if (!activeId) continue
    if (base === activeId || norm.endsWith(`/${activeId}`) || base.includes(activeId)) {
      return true
    }
  }

  return false
}

export interface RunHousekeepingOptions {
  db?: Database.Database | null
  dbPath?: string
  extraDbPaths?: readonly string[]
  projectRoot?: string
  env?: Record<string, string | undefined>
  retentionDays?: number
  nowMs?: number
  diskUsedPct?: number
  diskWarnPct?: number
  forceNpmCacheClean?: boolean
  npmCacheCleanRunner?: NpmCacheCleanRunner
}

/**
 * Runs automatic SSD housekeeping:
 * 1. SQLite `PRAGMA wal_checkpoint(TRUNCATE);`
 * 2. Retention-based deletion (`ALFRED_ARTIFACT_RETENTION_DAYS=30`) of old closed batch input/output artifacts,
 *    old rotated logs, and stale temporary files (`>24h`), while strictly preserving live SQLite DBs, `.env`,
 *    credentials, and active batch jobs.
 * 3. Emergency `npm cache clean --force` when disk usage reaches `ALFRED_DISK_WARN_PCT` (or `forceNpmCacheClean`).
 */
export async function runHousekeeping(
  opts: RunHousekeepingOptions = {},
): Promise<HousekeepingResult> {
  const env = opts.env ?? process.env
  const projectRoot = resolve(opts.projectRoot ?? process.cwd())
  const nowMs = opts.nowMs ?? Date.now()
  const retentionDays = opts.retentionDays ?? resolveArtifactRetentionDays(env)
  const retentionCutoffMs = nowMs - retentionDays * 86_400_000
  const tempCutoffMs = nowMs - 24 * 3_600_000

  const walCheckpoint = checkpointSqliteWal(opts.db, opts.dbPath, opts.extraDbPaths)
  const batchMeta = inspectBatchJobsTable(opts.db)

  const rotatedAppLogs: string[] = []
  try {
    rotatedAppLogs.push(...runLogRotationSweep(join(projectRoot, 'store')))
  } catch {
    // ignore log rotation sweep error
  }

  const deletedBatchFiles: string[] = []
  const deletedLogFiles: string[] = []
  const deletedTempFiles: string[] = []
  let reclaimedArtifactsBytes = 0

  const tryDeleteFile = (fullPath: string, bucket: string[]): void => {
    if (isProtectedHousekeepingPath(fullPath, batchMeta.activeIdentifiers)) {
      return
    }
    try {
      const st = statSync(fullPath)
      if (!st.isFile()) return
      unlinkSync(fullPath)
      reclaimedArtifactsBytes += st.size
      bucket.push(fullPath)
    } catch {
      // ignore race or permission error
    }
  }

  // 1. Clean expired closed batch input/output files in `batch/` and `store/batch/`
  const batchDirs = [join(projectRoot, 'batch'), join(projectRoot, 'store', 'batch')]
  for (const bDir of batchDirs) {
    if (!existsSync(bDir)) continue
    const walkBatch = (dir: string, depth: number) => {
      if (depth > 4) return
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue
        const fullPath = join(dir, entry.name)
        if (entry.isDirectory()) {
          walkBatch(fullPath, depth + 1)
          continue
        }
        if (!entry.isFile()) continue
        if (isProtectedHousekeepingPath(fullPath, batchMeta.activeIdentifiers)) continue

        let mtimeMs = nowMs
        try {
          mtimeMs = statSync(fullPath).mtimeMs
        } catch {
          continue
        }
        if (mtimeMs > retentionCutoffMs) continue

        // If batch_jobs exists and tracks jobs, never delete an active job's file (already checked in isProtectedHousekeepingPath).
        // If closedIdentifiers is non-empty, allow deleting closed job files or any batch artifact older than retentionCutoffMs not in activeIdentifiers.
        tryDeleteFile(fullPath, deletedBatchFiles)
      }
    }
    walkBatch(bDir, 0)
  }

  // 2. Clean expired log files in `logs/` and rotated/old logs in `store/`
  const logScanDirs = [
    { dir: join(projectRoot, 'logs'), allowPlainLog: true },
    { dir: join(projectRoot, 'store'), allowPlainLog: true },
  ]
  for (const { dir, allowPlainLog } of logScanDirs) {
    if (!existsSync(dir)) continue
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) continue
      const fullPath = join(dir, entry.name)
      if (isProtectedHousekeepingPath(fullPath, batchMeta.activeIdentifiers)) continue

      const isRotatedLog = /\.log\.\d+(?:\.gz)?$/i.test(entry.name) || /\.log-\d{8}(?:\.gz)?$/i.test(entry.name)
      const isPlainLog = allowPlainLog && /\.log$/i.test(entry.name)
      const isTmpFile = /\.tmp$/i.test(entry.name)

      let st
      try {
        st = statSync(fullPath)
      } catch {
        continue
      }

      if (isTmpFile && st.mtimeMs <= tempCutoffMs) {
        tryDeleteFile(fullPath, deletedTempFiles)
      } else if ((isRotatedLog || isPlainLog) && st.mtimeMs <= retentionCutoffMs) {
        tryDeleteFile(fullPath, deletedLogFiles)
      }
    }
  }

  // 3. Clean stale atomic-write `.tmp` files in projectRoot (e.g. `.env.<pid>.<ts>.<hex>.tmp` older than 24h)
  if (existsSync(projectRoot)) {
    try {
      const rootEntries = readdirSync(projectRoot, { withFileTypes: true })
      for (const entry of rootEntries) {
        if (!entry.isFile() || entry.isSymbolicLink()) continue
        if (!/\.tmp$/i.test(entry.name)) continue
        const fullPath = join(projectRoot, entry.name)
        if (isProtectedHousekeepingPath(fullPath, batchMeta.activeIdentifiers)) continue
        try {
          const st = statSync(fullPath)
          if (st.mtimeMs <= tempCutoffMs) {
            tryDeleteFile(fullPath, deletedTempFiles)
          }
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  }

  // 4. Emergency npm cache clean when disk usage reaches ALFRED_DISK_WARN_PCT (or forced)
  const diskWarnPct = opts.diskWarnPct ?? 80
  const shouldCleanNpmCache =
    opts.forceNpmCacheClean === true ||
    (typeof opts.diskUsedPct === 'number' && opts.diskUsedPct >= diskWarnPct)

  let npmCacheCleaned = false
  let npmCacheOutput: string | undefined
  if (shouldCleanNpmCache) {
    const runner = opts.npmCacheCleanRunner ?? defaultNpmCacheCleanRunner
    try {
      npmCacheOutput = await runner(env)
      npmCacheCleaned = true
    } catch (err) {
      npmCacheOutput = err instanceof Error ? err.message : String(err)
      npmCacheCleaned = false
    }
  }

  const deletedFilesCount =
    deletedBatchFiles.length + deletedLogFiles.length + deletedTempFiles.length
  const totalReclaimedBytes = walCheckpoint.walReclaimedBytes + reclaimedArtifactsBytes

  return {
    executedAt: new Date(nowMs).toISOString(),
    retentionDays,
    walCheckpoint,
    rotatedAppLogs,
    deletedBatchFiles,
    deletedLogFiles,
    deletedTempFiles,
    deletedFilesCount,
    reclaimedArtifactsBytes,
    npmCacheCleaned,
    ...(npmCacheOutput !== undefined ? { npmCacheOutput } : {}),
    totalReclaimedBytes,
  }
}
