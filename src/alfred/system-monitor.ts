import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type SystemAlertLevel = 'ok' | 'warn' | 'crit'

export interface SystemThresholds {
  memWarnPct: number
  diskWarnPct: number
  diskCritPct: number
  cooldownMs: number
}

export interface MemoryTelemetry {
  totalBytes: number
  usedBytes: number
  availBytes: number
  usedPct: number
  totalMb: number
  usedMb: number
  availMb: number
  swapTotalBytes: number
  swapUsedBytes: number
  swapFreeBytes: number
  swapUsedPct: number
  swapTotalMb: number
  swapUsedMb: number
  swapFreeMb: number
  processRssBytes: number
  processRssMb: number
  processHeapUsedBytes: number
  processHeapUsedMb: number
  processHeapTotalBytes: number
  processHeapTotalMb: number
}

export interface DiskPartitionTelemetry {
  filesystem: string
  sizeBytes: number
  usedBytes: number
  availBytes: number
  usedPct: number
  mountpoint: string
  targetPath: string
}

export interface DirectoryStorageEntry {
  key: 'store' | 'logs' | 'batch' | 'homeLocal' | 'homeNpm'
  label: string
  path: string
  exists: boolean
  bytes: number
  mb: number
  fileCount: number
  dbBytes?: number
  walBytes?: number
}

export interface SystemHealthEvaluation {
  overallLevel: SystemAlertLevel
  memLevel: SystemAlertLevel
  diskLevel: SystemAlertLevel
  maxDiskUsedPct: number
  reasons: string[]
}

export interface SystemTelemetrySnapshot {
  capturedAt: string
  hostname: string
  uptimeSec: number
  memory: MemoryTelemetry
  partitions: DiskPartitionTelemetry[]
  directories: DirectoryStorageEntry[]
  thresholds: SystemThresholds
  health: SystemHealthEvaluation
}

function clampPct(raw: string | undefined, fallback: number): number {
  if (!raw || !raw.trim()) return fallback
  const n = Number(raw.trim())
  if (!Number.isFinite(n)) return fallback
  return Math.max(1, Math.min(100, Math.round(n)))
}

export function resolveSystemThresholds(
  env: Record<string, string | undefined> = process.env,
): SystemThresholds {
  const memWarnPct = clampPct(env['ALFRED_MEM_WARN_PCT'], 85)
  const diskWarnPct = clampPct(env['ALFRED_DISK_WARN_PCT'], 80)
  const rawCrit = clampPct(env['ALFRED_DISK_CRIT_PCT'], 90)
  const diskCritPct = Math.max(diskWarnPct, rawCrit)

  const rawCooldown = env['ALFRED_MONITOR_COOLDOWN_MS']?.trim()
  const parsedCooldown = rawCooldown ? Number(rawCooldown) : NaN
  const cooldownMs =
    Number.isFinite(parsedCooldown) && parsedCooldown >= 0 ? Math.round(parsedCooldown) : 3_600_000

  return {
    memWarnPct,
    diskWarnPct,
    diskCritPct,
    cooldownMs,
  }
}

export interface ParsedProcMeminfo {
  memTotalBytes: number
  memAvailableBytes: number
  memFreeBytes: number
  buffersBytes: number
  cachedBytes: number
  swapTotalBytes: number
  swapFreeBytes: number
}

export function parseProcMeminfo(raw: string): ParsedProcMeminfo | null {
  const valuesKb = new Map<string, number>()
  for (const line of raw.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_()]+):\s+(\d+)(?:\s+kB)?/i.exec(line.trim())
    if (!m) continue
    valuesKb.set(m[1], Number(m[2]))
  }
  const memTotalKb = valuesKb.get('MemTotal')
  if (memTotalKb === undefined || !Number.isFinite(memTotalKb) || memTotalKb <= 0) {
    return null
  }
  const memFreeKb = valuesKb.get('MemFree') ?? 0
  const buffersKb = valuesKb.get('Buffers') ?? 0
  const cachedKb = valuesKb.get('Cached') ?? 0
  const memAvailKb =
    valuesKb.get('MemAvailable') ?? Math.min(memTotalKb, memFreeKb + buffersKb + cachedKb)
  const swapTotalKb = valuesKb.get('SwapTotal') ?? 0
  const swapFreeKb = valuesKb.get('SwapFree') ?? 0

  return {
    memTotalBytes: memTotalKb * 1024,
    memAvailableBytes: Math.max(0, Math.min(memTotalKb * 1024, memAvailKb * 1024)),
    memFreeBytes: Math.max(0, memFreeKb * 1024),
    buffersBytes: Math.max(0, buffersKb * 1024),
    cachedBytes: Math.max(0, cachedKb * 1024),
    swapTotalBytes: Math.max(0, swapTotalKb * 1024),
    swapFreeBytes: Math.max(0, Math.min(swapTotalKb * 1024, swapFreeKb * 1024)),
  }
}

function toMb(bytes: number): number {
  return Math.round((bytes / 1_048_576) * 10) / 10
}

function toPct(used: number, total: number): number {
  if (total <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((used / total) * 1000) / 10))
}

export interface ReadMemoryTelemetryOptions {
  procMeminfoText?: string
  procMeminfoPath?: string
  processMemoryUsageFn?: () => NodeJS.MemoryUsage
}

export function readMemoryTelemetry(opts: ReadMemoryTelemetryOptions = {}): MemoryTelemetry {
  let rawProc = opts.procMeminfoText
  const meminfoPath = opts.procMeminfoPath ?? '/proc/meminfo'
  if (rawProc === undefined && existsSync(meminfoPath)) {
    try {
      rawProc = readFileSync(meminfoPath, 'utf-8')
    } catch {
      rawProc = undefined
    }
  }

  const parsed = rawProc ? parseProcMeminfo(rawProc) : null
  const totalBytes = parsed ? parsed.memTotalBytes : os.totalmem()
  const availBytes = parsed ? parsed.memAvailableBytes : os.freemem()
  const usedBytes = Math.max(0, totalBytes - availBytes)
  const usedPct = toPct(usedBytes, totalBytes)

  const swapTotalBytes = parsed ? parsed.swapTotalBytes : 0
  const swapFreeBytes = parsed ? parsed.swapFreeBytes : 0
  const swapUsedBytes = Math.max(0, swapTotalBytes - swapFreeBytes)
  const swapUsedPct = toPct(swapUsedBytes, swapTotalBytes)

  const memUsage = (opts.processMemoryUsageFn ?? process.memoryUsage)()

  return {
    totalBytes,
    usedBytes,
    availBytes,
    usedPct,
    totalMb: Math.round(totalBytes / 1_048_576),
    usedMb: Math.round(usedBytes / 1_048_576),
    availMb: Math.round(availBytes / 1_048_576),
    swapTotalBytes,
    swapUsedBytes,
    swapFreeBytes,
    swapUsedPct,
    swapTotalMb: Math.round(swapTotalBytes / 1_048_576),
    swapUsedMb: Math.round(swapUsedBytes / 1_048_576),
    swapFreeMb: Math.round(swapFreeBytes / 1_048_576),
    processRssBytes: memUsage.rss,
    processRssMb: toMb(memUsage.rss),
    processHeapUsedBytes: memUsage.heapUsed,
    processHeapUsedMb: toMb(memUsage.heapUsed),
    processHeapTotalBytes: memUsage.heapTotal,
    processHeapTotalMb: toMb(memUsage.heapTotal),
  }
}

export function parseDfOutput(raw: string, targetPath = '/'): DiskPartitionTelemetry[] {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)

  const out: DiskPartitionTelemetry[] = []
  for (const line of lines) {
    if (/^Filesystem\b/i.test(line)) continue
    // POSIX `df -kP`: Filesystem 1024-blocks Used Available Capacity Mounted_on
    const m = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/.exec(line)
    if (!m) continue
    const sizeKb = Number(m[2])
    const usedKb = Number(m[3])
    const availKb = Number(m[4])
    const capPct = Number(m[5])
    if (!Number.isFinite(sizeKb) || sizeKb <= 0) continue

    const sizeBytes = sizeKb * 1024
    const usedBytes = usedKb * 1024
    const availBytes = availKb * 1024
    const usedPct = Number.isFinite(capPct) ? capPct : toPct(usedBytes, sizeBytes)

    out.push({
      filesystem: m[1],
      sizeBytes,
      usedBytes,
      availBytes,
      usedPct,
      mountpoint: m[6].trim(),
      targetPath,
    })
  }
  return out
}

export type DfCommandRunner = (targetPaths: string[]) => Promise<string>

async function defaultDfRunner(targetPaths: string[]): Promise<string> {
  const { stdout } = await execFileAsync('df', ['-kP', ...targetPaths], { timeout: 4_000 })
  return stdout
}

export interface ReadDiskPartitionsOptions {
  targetPaths?: string[]
  dfRunner?: DfCommandRunner
  projectRoot?: string
}

export async function readDiskPartitions(
  opts: ReadDiskPartitionsOptions = {},
): Promise<DiskPartitionTelemetry[]> {
  const projectRoot = opts.projectRoot ?? process.cwd()
  const candidateTargets = opts.targetPaths ?? [
    '/',
    '/opt/alfred-prod',
    '/opt/alfred-ops',
    '/opt/alfred-worktrees',
    projectRoot,
  ]

  const existingTargets: string[] = []
  for (const p of candidateTargets) {
    if (!p) continue
    if (opts.dfRunner || existsSync(p)) {
      if (!existingTargets.includes(p)) existingTargets.push(p)
    }
  }

  if (opts.dfRunner || process.platform !== 'win32') {
    const runner = opts.dfRunner ?? defaultDfRunner
    const seenMounts = new Set<string>()
    const partitions: DiskPartitionTelemetry[] = []

    for (const target of existingTargets.length > 0 ? existingTargets : ['/']) {
      try {
        const stdout = await runner([target])
        const parsed = parseDfOutput(stdout, target)
        for (const item of parsed) {
          const dedupKey = `${item.filesystem}::${item.mountpoint}`
          if (seenMounts.has(dedupKey)) continue
          seenMounts.add(dedupKey)
          partitions.push(item)
        }
      } catch {
        // ignore missing or inaccessible path
      }
    }

    if (partitions.length > 0) {
      return partitions
    }
  }

  return []
}

function walkDirectoryStats(
  dirPath: string,
  maxDepth = 5,
  maxEntries = 15_000,
): { bytes: number; fileCount: number; dbBytes: number; walBytes: number } {
  if (!existsSync(dirPath)) {
    return { bytes: 0, fileCount: 0, dbBytes: 0, walBytes: 0 }
  }

  let bytes = 0
  let fileCount = 0
  let dbBytes = 0
  let walBytes = 0
  let visited = 0

  function walk(current: string, depth: number): void {
    if (depth > maxDepth || visited >= maxEntries) return
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (visited >= maxEntries) break
      visited += 1
      const fullPath = join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1)
      } else if (entry.isFile()) {
        try {
          const st = statSync(fullPath)
          bytes += st.size
          fileCount += 1
          if (/\.db$/i.test(entry.name)) {
            dbBytes += st.size
          } else if (/\.db-wal$/i.test(entry.name)) {
            walBytes += st.size
          }
        } catch {
          // ignore race condition on transient files
        }
      }
    }
  }

  walk(dirPath, 0)
  return { bytes, fileCount, dbBytes, walBytes }
}

export interface CollectDirectoryBreakdownOptions {
  projectRoot?: string
  homeDir?: string
  env?: Record<string, string | undefined>
}

export function collectDirectoryBreakdown(
  opts: CollectDirectoryBreakdownOptions = {},
): DirectoryStorageEntry[] {
  const projectRoot = resolve(opts.projectRoot ?? process.cwd())
  const homeDir = resolve(
    opts.homeDir ?? opts.env?.['HOME'] ?? opts.env?.['USERPROFILE'] ?? os.homedir(),
  )

  const storeDir = join(projectRoot, 'store')
  const logsDir = join(projectRoot, 'logs')
  const batchPrimaryDir = join(projectRoot, 'batch')
  const batchStoreDir = join(storeDir, 'batch')
  const batchDir = existsSync(batchPrimaryDir)
    ? batchPrimaryDir
    : existsSync(batchStoreDir)
      ? batchStoreDir
      : batchPrimaryDir
  const homeLocalDir = join(homeDir, '.local')
  const homeNpmDir = join(homeDir, '.npm')

  const specs: Array<{
    key: DirectoryStorageEntry['key']
    label: string
    path: string
    includeDbStats?: boolean
  }> = [
    { key: 'store', label: 'store/', path: storeDir, includeDbStats: true },
    { key: 'logs', label: 'logs/', path: logsDir },
    { key: 'batch', label: 'batch/', path: batchDir },
    { key: 'homeLocal', label: '~/.local', path: homeLocalDir },
    { key: 'homeNpm', label: '~/.npm', path: homeNpmDir },
  ]

  return specs.map((spec) => {
    const exists = existsSync(spec.path)
    const stats = exists
      ? walkDirectoryStats(spec.path)
      : { bytes: 0, fileCount: 0, dbBytes: 0, walBytes: 0 }
    return {
      key: spec.key,
      label: spec.label,
      path: spec.path,
      exists,
      bytes: stats.bytes,
      mb: toMb(stats.bytes),
      fileCount: stats.fileCount,
      ...(spec.includeDbStats
        ? {
          dbBytes: stats.dbBytes,
          walBytes: stats.walBytes,
        }
        : {}),
    }
  })
}

export function evaluateSystemHealth(params: {
  memory: Pick<MemoryTelemetry, 'usedPct' | 'usedMb' | 'totalMb' | 'processRssMb'>
  partitions: ReadonlyArray<Pick<DiskPartitionTelemetry, 'mountpoint' | 'usedPct' | 'availBytes'>>
  thresholds: SystemThresholds
}): SystemHealthEvaluation {
  const { memory, partitions, thresholds } = params
  const reasons: string[] = []

  const memLevel: SystemAlertLevel = memory.usedPct >= thresholds.memWarnPct ? 'warn' : 'ok'
  if (memLevel === 'warn') {
    reasons.push(
      `RAM telítettség magas: ${memory.usedPct.toFixed(1)}% (${memory.usedMb}/${memory.totalMb} MB, küszöb: ${thresholds.memWarnPct}%)`,
    )
  }

  let diskLevel: SystemAlertLevel = 'ok'
  let maxDiskUsedPct = 0
  for (const part of partitions) {
    if (part.usedPct > maxDiskUsedPct) {
      maxDiskUsedPct = part.usedPct
    }
    if (part.usedPct >= thresholds.diskCritPct) {
      diskLevel = 'crit'
      reasons.push(
        `SSD KRITIKUS telítettség (${part.mountpoint}): ${part.usedPct.toFixed(1)}% (kritikus küszöb: ${thresholds.diskCritPct}%)`,
      )
    } else if (part.usedPct >= thresholds.diskWarnPct) {
      if (diskLevel === 'ok') diskLevel = 'warn'
      reasons.push(
        `SSD figyelmeztetési szint (${part.mountpoint}): ${part.usedPct.toFixed(1)}% (küszöb: ${thresholds.diskWarnPct}%)`,
      )
    }
  }

  const levelRank: Record<SystemAlertLevel, number> = { ok: 0, warn: 1, crit: 2 }
  const overallLevel: SystemAlertLevel =
    levelRank[diskLevel] >= levelRank[memLevel] ? diskLevel : memLevel

  return {
    overallLevel,
    memLevel,
    diskLevel,
    maxDiskUsedPct,
    reasons,
  }
}

export interface CollectSystemTelemetryOptions
  extends ReadMemoryTelemetryOptions,
    ReadDiskPartitionsOptions,
    CollectDirectoryBreakdownOptions {}

export async function collectSystemTelemetry(
  opts: CollectSystemTelemetryOptions = {},
): Promise<SystemTelemetrySnapshot> {
  const env = opts.env ?? process.env
  const thresholds = resolveSystemThresholds(env)
  const memory = readMemoryTelemetry(opts)
  const partitions = await readDiskPartitions(opts)
  const directories = collectDirectoryBreakdown(opts)
  const health = evaluateSystemHealth({ memory, partitions, thresholds })

  return {
    capturedAt: new Date().toISOString(),
    hostname: os.hostname(),
    uptimeSec: Math.round(os.uptime()),
    memory,
    partitions,
    directories,
    thresholds,
    health,
  }
}

const ALERT_RANK: Record<SystemAlertLevel, number> = {
  ok: 0,
  warn: 1,
  crit: 2,
}

/**
 * Tracks alert emission timestamps so `#alfred-ops` is not spammed on every heartbeat tick,
 * while still allowing immediate emission when severity escalates from `warn` to `crit`.
 */
export class SystemAlertTracker {
  private lastLevel: SystemAlertLevel = 'ok'
  private lastAlertAtMs = 0

  shouldEmitAlert(level: SystemAlertLevel, cooldownMs: number, nowMs = Date.now()): boolean {
    if (level === 'ok') {
      this.lastLevel = 'ok'
      return false
    }
    if (this.lastAlertAtMs === 0) {
      return true
    }
    if (ALERT_RANK[level] > ALERT_RANK[this.lastLevel]) {
      return true
    }
    return nowMs - this.lastAlertAtMs >= cooldownMs
  }

  recordAlertSent(level: SystemAlertLevel, nowMs = Date.now()): void {
    this.lastLevel = level
    this.lastAlertAtMs = nowMs
  }

  reset(): void {
    this.lastLevel = 'ok'
    this.lastAlertAtMs = 0
  }
}

export function formatBytesHuman(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let val = bytes
  let idx = 0
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024
    idx += 1
  }
  return `${val >= 10 || idx === 0 ? val.toFixed(idx === 0 ? 0 : 1) : val.toFixed(2)} ${units[idx]}`
}

export function formatSystemAlertDiscordMessage(
  snapshot: SystemTelemetrySnapshot,
  cleanupSummary?: {
    totalReclaimedBytes: number
    deletedFilesCount: number
    walReclaimedBytes?: number
    walCheckpoint?: { walReclaimedBytes: number }
    npmCacheCleaned: boolean
  } | null,
): string {
  const icon = snapshot.health.overallLevel === 'crit' ? '🚨' : '⚠️'
  const title =
    snapshot.health.overallLevel === 'crit'
      ? `${icon} **[CRITICAL] Alfred VPS Erőforrás Riasztás (${snapshot.hostname})**`
      : `${icon} **[WARN] Alfred VPS Erőforrás Figyelmeztetés (${snapshot.hostname})**`

  const m = snapshot.memory
  const lines: string[] = [
    title,
    ...snapshot.health.reasons.map((r) => `• ${r}`),
    '',
    `**Memória:** RAM ${m.usedMb}/${m.totalMb} MB (${m.usedPct.toFixed(1)}%, szabad: ${m.availMb} MB) · Swap ${m.swapUsedMb}/${m.swapTotalMb} MB (${m.swapUsedPct.toFixed(1)}%) · Node RSS: ${m.processRssMb} MB`,
  ]

  if (snapshot.partitions.length > 0) {
    const partText = snapshot.partitions
      .map(
        (p) =>
          `\`${p.mountpoint}\`: ${formatBytesHuman(p.usedBytes)} / ${formatBytesHuman(p.sizeBytes)} (${p.usedPct.toFixed(1)}%, szabad: ${formatBytesHuman(p.availBytes)})`,
      )
      .join(' · ')
    lines.push(`**Partíciók:** ${partText}`)
  }

  const dirText = snapshot.directories
    .map((d) => {
      const extra =
        d.key === 'store' && d.walBytes !== undefined
          ? ` (DB: ${formatBytesHuman(d.dbBytes ?? 0)}, WAL: ${formatBytesHuman(d.walBytes)})`
          : ''
      return `\`${d.label}\`: ${formatBytesHuman(d.bytes)}${extra}`
    })
    .join(' · ')
  if (dirText) {
    lines.push(`**Mappabontás:** ${dirText}`)
  }

  if (cleanupSummary) {
    const walBytes =
      cleanupSummary.walReclaimedBytes ?? cleanupSummary.walCheckpoint?.walReclaimedBytes ?? 0
    lines.push(
      `**Automatikus Housekeeping lefutott:** felszabadítva **${formatBytesHuman(cleanupSummary.totalReclaimedBytes)}** (${cleanupSummary.deletedFilesCount} régi fájl törölve, WAL: ${formatBytesHuman(walBytes)}, npm cache clean: ${cleanupSummary.npmCacheCleaned ? 'igen' : 'nem'}).`,
    )
  }

  return lines.join('\n')
}
