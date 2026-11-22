import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import type http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  collectDirectoryBreakdown,
  evaluateSystemHealth,
  executeWhitelistedToolAsync,
  formatSystemAlertDiscordMessage,
  inspectBatchJobsTable,
  isProtectedHousekeepingPath,
  loadAlfredAgentsConfig,
  parseDfOutput,
  parseProcMeminfo,
  readMemoryTelemetry,
  resolveSystemThresholds,
  runHousekeeping,
   SystemAlertTracker,
  ToolNotAllowedError,
} from '../alfred/index.js'
import { runResourceHeartbeatTick } from '../alfred/run.js'
import { getDb, initDatabase } from '../db.js'
import { tryHandleAlfredVps } from '../web/routes/alfred-vps.js'
import type { RouteContext } from '../web/routes/types.js'

function mockReqRes(
  method: string,
  path: string,
  opts?: { body?: unknown; headers?: Record<string, string> },
): {
  ctx: RouteContext
  getStatus: () => number
  getJson: () => Record<string, unknown>
} {
  const req = new EventEmitter() as http.IncomingMessage
  req.method = method
  req.url = path
  req.headers = {
    'content-type': 'application/json',
    ...(opts?.headers ?? {}),
  }
  if (opts?.body !== undefined) {
    queueMicrotask(() => {
      req.emit('data', Buffer.from(JSON.stringify(opts.body), 'utf-8'))
      req.emit('end')
    })
  } else {
    queueMicrotask(() => req.emit('end'))
  }

  let status = 200
  let rawBody = ''
  const res = {
    writeHead(code: number) {
      status = code
      return this
    },
    end(chunk?: string | Buffer) {
      if (chunk) rawBody += chunk.toString()
      return this
    },
    setHeader() {
      return this
    },
  } as unknown as http.ServerResponse

  const url = new URL(`http://127.0.0.1:3420${path}`)
  return {
    ctx: { req, res, path: url.pathname, method, url },
    getStatus: () => status,
    getJson: () => JSON.parse(rawBody || '{}') as Record<string, unknown>,
  }
}

describe('Alfred System Monitor & Automatic Housekeeper', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'alfred-sysmon-test-'))
    initDatabase(':memory:')
  })

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup error
    }
  })

  it('parses /proc/meminfo, df -kP output, and evaluates configurable thresholds', () => {
    const rawMeminfo = [
      'MemTotal:        4096000 kB',
      'MemFree:          400000 kB',
      'MemAvailable:     512000 kB',
      'Buffers:           50000 kB',
      'Cached:           100000 kB',
      'SwapTotal:       2097152 kB',
      'SwapFree:        1572864 kB',
    ].join('\n')

    const parsedMem = parseProcMeminfo(rawMeminfo)
    expect(parsedMem).not.toBeNull()
    expect(parsedMem!.memTotalBytes).toBe(4_096_000 * 1024)
    expect(parsedMem!.memAvailableBytes).toBe(512_000 * 1024)

    const memTelemetry = readMemoryTelemetry({
      procMeminfoText: rawMeminfo,
      processMemoryUsageFn: () => ({
        rss: 150 * 1048576,
        heapTotal: 90 * 1048576,
        heapUsed: 65 * 1048576,
        external: 0,
        arrayBuffers: 0,
      }),
    })
    expect(memTelemetry.totalMb).toBe(4000)
    expect(memTelemetry.availMb).toBe(500)
    expect(memTelemetry.usedMb).toBe(3500)
    expect(memTelemetry.usedPct).toBeCloseTo(87.5, 1)
    expect(memTelemetry.swapTotalMb).toBe(2048)
    expect(memTelemetry.swapUsedMb).toBe(512)
    expect(memTelemetry.swapUsedPct).toBeCloseTo(25, 1)
    expect(memTelemetry.processRssMb).toBe(150)

    const rawDf = [
      'Filesystem     1024-blocks     Used Available Capacity Mounted on',
      '/dev/sda1         41943040 35651584   6291456      85% /',
    ].join('\n')
    const partitions = parseDfOutput(rawDf, '/')
    expect(partitions).toHaveLength(1)
    expect(partitions[0].mountpoint).toBe('/')
    expect(partitions[0].usedPct).toBe(85)

    const thresholds = resolveSystemThresholds({
      ALFRED_MEM_WARN_PCT: '85',
      ALFRED_DISK_WARN_PCT: '80',
      ALFRED_DISK_CRIT_PCT: '90',
    })
    expect(thresholds).toEqual({
      memWarnPct: 85,
      diskWarnPct: 80,
      diskCritPct: 90,
      cooldownMs: 3_600_000,
    })

    const healthWarn = evaluateSystemHealth({
      memory: memTelemetry,
      partitions,
      thresholds,
    })
    expect(healthWarn.memLevel).toBe('warn')
    expect(healthWarn.diskLevel).toBe('warn')
    expect(healthWarn.overallLevel).toBe('warn')
    expect(healthWarn.reasons.length).toBeGreaterThanOrEqual(2)

    const healthCrit = evaluateSystemHealth({
      memory: memTelemetry,
      partitions: [{ mountpoint: '/opt/alfred-prod', usedPct: 92, availBytes: 1_000_000 }],
      thresholds,
    })
    expect(healthCrit.diskLevel).toBe('crit')
    expect(healthCrit.overallLevel).toBe('crit')
  })

  it('enforces alert cooldown and allows immediate escalation from warn to crit', () => {
    const tracker = new SystemAlertTracker()
    const cooldownMs = 3_600_000
    const t0 = 1_700_000_000_000

    expect(tracker.shouldEmitAlert('ok', cooldownMs, t0)).toBe(false)
    expect(tracker.shouldEmitAlert('warn', cooldownMs, t0)).toBe(true)
    tracker.recordAlertSent('warn', t0)

    // Within cooldown at same severity -> suppressed
    expect(tracker.shouldEmitAlert('warn', cooldownMs, t0 + 60_000)).toBe(false)

    // Escalation from warn -> crit bypasses cooldown immediately
    expect(tracker.shouldEmitAlert('crit', cooldownMs, t0 + 120_000)).toBe(true)
    tracker.recordAlertSent('crit', t0 + 120_000)

    // Same crit within cooldown -> suppressed
    expect(tracker.shouldEmitAlert('crit', cooldownMs, t0 + 180_000)).toBe(false)

    // After cooldown expires -> allowed again
    expect(tracker.shouldEmitAlert('crit', cooldownMs, t0 + 120_000 + cooldownMs + 1)).toBe(true)
  })

  it('safely checks sqlite_master for batch_jobs and preserves protected files during retention cleanup', async () => {
    const ws = join(tempDir, 'project')
    mkdirSync(join(ws, 'store', 'batch'), { recursive: true })
    mkdirSync(join(ws, 'batch'), { recursive: true })
    mkdirSync(join(ws, 'logs'), { recursive: true })

    // Create a real file-backed SQLite database in WAL mode to test PRAGMA wal_checkpoint(TRUNCATE)
    const dbPath = join(ws, 'store', 'alfred.db')
    const fileDb = new Database(dbPath)
    fileDb.pragma('journal_mode = WAL')
    fileDb.exec('CREATE TABLE sample_items (id INTEGER PRIMARY KEY, payload TEXT)')
    for (let i = 0; i < 50; i++) {
      fileDb.prepare('INSERT INTO sample_items (payload) VALUES (?)').run('x'.repeat(500))
    }

    // 1. Verify inspectBatchJobsTable does NOT throw when batch_jobs table does not exist yet
    const metaWithoutTable = inspectBatchJobsTable(fileDb)
    expect(metaWithoutTable.hasBatchJobsTable).toBe(false)
    expect(metaWithoutTable.activeIdentifiers.size).toBe(0)

    // Create protected files (some with old timestamps to prove they are NEVER deleted even if old)
    const nowMs = Date.now()
    const oldTimeSec = Math.floor((nowMs - 45 * 86_400_000) / 1000)
    const recentTimeSec = Math.floor((nowMs - 2 * 86_400_000) / 1000)

    const envFile = join(ws, '.env')
    const envTestFile = join(ws, '.env.test')
    const dashTokenFile = join(ws, 'store', '.dashboard-token')
    const saFile = join(ws, 'store', 'vertex-eu-sa.json')
    writeFileSync(envFile, 'SECRET=1\n', 'utf-8')
    writeFileSync(envTestFile, 'SECRET_TEST=1\n', 'utf-8')
    writeFileSync(dashTokenFile, 'tok-123\n', 'utf-8')
    writeFileSync(saFile, '{"type":"service_account"}\n', 'utf-8')
    for (const p of [envFile, envTestFile, dashTokenFile, saFile]) {
      utimesSync(p, oldTimeSec, oldTimeSec)
      expect(isProtectedHousekeepingPath(p)).toBe(true)
    }

    // Create stale atomic-write .env.<pid>.<ts>.<hex>.tmp file (>24h old) -> should be cleaned up
    const staleEnvTmp = join(ws, '.env.14402.1795267148722.df3d9465.tmp')
    writeFileSync(staleEnvTmp, 'OLD_TMP=1\n', 'utf-8')
    utimesSync(staleEnvTmp, oldTimeSec, oldTimeSec)

    // Create old & recent log files
    const oldLog = join(ws, 'logs', 'alfred-2026-01.log')
    const recentLog = join(ws, 'logs', 'alfred-current.log')
    writeFileSync(oldLog, 'old log content'.repeat(100), 'utf-8')
    writeFileSync(recentLog, 'recent log content', 'utf-8')
    utimesSync(oldLog, oldTimeSec, oldTimeSec)
    utimesSync(recentLog, recentTimeSec, recentTimeSec)

    // Create batch_jobs table to test active vs closed batch artifact protection
    fileDb.exec(`
      CREATE TABLE batch_jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        input_path TEXT,
        output_path TEXT
      )
    `)
    const oldClosedBatchFile = join(ws, 'batch', 'job-closed-old-output.jsonl')
    const oldActiveBatchFile = join(ws, 'batch', 'job-running-old-input.jsonl')
    const recentClosedBatchFile = join(ws, 'batch', 'job-closed-recent-output.jsonl')
    writeFileSync(oldClosedBatchFile, '{"result":"done"}\n'.repeat(50), 'utf-8')
    writeFileSync(oldActiveBatchFile, '{"prompt":"still running"}\n', 'utf-8')
    writeFileSync(recentClosedBatchFile, '{"result":"recent"}\n', 'utf-8')
    utimesSync(oldClosedBatchFile, oldTimeSec, oldTimeSec)
    utimesSync(oldActiveBatchFile, oldTimeSec, oldTimeSec)
    utimesSync(recentClosedBatchFile, recentTimeSec, recentTimeSec)

    fileDb
      .prepare('INSERT INTO batch_jobs (id, status, input_path, output_path) VALUES (?, ?, ?, ?)')
      .run('job-closed-old', 'completed', null, oldClosedBatchFile)
    fileDb
      .prepare('INSERT INTO batch_jobs (id, status, input_path, output_path) VALUES (?, ?, ?, ?)')
      .run('job-running-old', 'running', oldActiveBatchFile, null)
    fileDb
      .prepare('INSERT INTO batch_jobs (id, status, input_path, output_path) VALUES (?, ?, ?, ?)')
      .run('job-closed-recent', 'failed', null, recentClosedBatchFile)

    let npmCacheCalls = 0
    const result = await runHousekeeping({
      db: fileDb,
      dbPath,
      projectRoot: ws,
      retentionDays: 30,
      nowMs,
      diskUsedPct: 84, // >= 80% warn threshold -> triggers emergency npm cache clean
      diskWarnPct: 80,
      npmCacheCleanRunner: async () => {
        npmCacheCalls += 1
        return 'npm cache cleaned'
      },
    })

    fileDb.close()

    // Old closed batch file, old log, and stale .tmp file were deleted
    expect(existsSync(oldClosedBatchFile)).toBe(false)
    expect(existsSync(oldLog)).toBe(false)
    expect(existsSync(staleEnvTmp)).toBe(false)
    expect(result.deletedFilesCount).toBe(3)
    expect(result.npmCacheCleaned).toBe(true)
    expect(npmCacheCalls).toBe(1)

    // Protected files, active batch job files, and recent files are strictly preserved
    expect(existsSync(dbPath)).toBe(true)
    expect(existsSync(envFile)).toBe(true)
    expect(existsSync(envTestFile)).toBe(true)
    expect(existsSync(dashTokenFile)).toBe(true)
    expect(existsSync(saFile)).toBe(true)
    expect(existsSync(oldActiveBatchFile)).toBe(true)
    expect(existsSync(recentClosedBatchFile)).toBe(true)
    expect(existsSync(recentLog)).toBe(true)

    const breakdown = collectDirectoryBreakdown({ projectRoot: ws, homeDir: tempDir })
    const storeEntry = breakdown.find((d) => d.key === 'store')
    expect(storeEntry?.exists).toBe(true)
    expect(storeEntry?.dbBytes).toBeGreaterThan(0)
  })

  it('runs auto-housekeeping and sends structured alert to #alfred-ops on heartbeat threshold breach', async () => {
    const tracker = new SystemAlertTracker()
    const sentMessages: Array<{ channelId: string; text: string }> = []
    let housekeepingRuns = 0

    const cfg = loadAlfredAgentsConfig({
      env: {
        ALFRED_ENV: 'ops',
        ALFRED_ENABLED_AGENTS: 'alfred-ops',
        DISCORD_CHANNEL_ALFRED_OPS: '5555555555555555555',
      },
      provisionWorkspaces: false,
    })

    const fakeSnapshot = {
      capturedAt: new Date().toISOString(),
      hostname: 'alfred-vps',
      uptimeSec: 3600,
      memory: {
        totalBytes: 4000 * 1048576,
        usedBytes: 3600 * 1048576,
        availBytes: 400 * 1048576,
        usedPct: 90,
        totalMb: 4000,
        usedMb: 3600,
        availMb: 400,
        swapTotalBytes: 2048 * 1048576,
        swapUsedBytes: 256 * 1048576,
        swapFreeBytes: 1792 * 1048576,
        swapUsedPct: 12.5,
        swapTotalMb: 2048,
        swapUsedMb: 256,
        swapFreeMb: 1792,
        processRssBytes: 180 * 1048576,
        processRssMb: 180,
        processHeapUsedBytes: 90 * 1048576,
        processHeapUsedMb: 90,
        processHeapTotalBytes: 120 * 1048576,
        processHeapTotalMb: 120,
      },
      partitions: [
        {
          filesystem: '/dev/sda1',
          sizeBytes: 40 * 1073741824,
          usedBytes: 34 * 1073741824,
          availBytes: 6 * 1073741824,
          usedPct: 85,
          mountpoint: '/',
          targetPath: '/',
        },
      ],
      directories: [
        {
          key: 'store' as const,
          label: 'store/',
          path: '/opt/alfred-prod/store',
          exists: true,
          bytes: 12 * 1048576,
          mb: 12,
          fileCount: 5,
          dbBytes: 8 * 1048576,
          walBytes: 4 * 1048576,
        },
      ],
      thresholds: {
        memWarnPct: 85,
        diskWarnPct: 80,
        diskCritPct: 90,
        cooldownMs: 3_600_000,
      },
      health: {
        overallLevel: 'warn' as const,
        memLevel: 'warn' as const,
        diskLevel: 'warn' as const,
        maxDiskUsedPct: 85,
        reasons: ['RAM telítettség magas: 90.0%', 'SSD figyelmeztetési szint (/): 85.0%'],
      },
    }

    const t0 = 1_700_000_000_000
    const tick1 = await runResourceHeartbeatTick({
      agentsConfig: cfg,
      alertTracker: tracker,
      nowMs: t0,
      env: { DISCORD_CHANNEL_ALFRED_OPS: '5555555555555555555' },
      sendToDiscord: async (channelId, text) => {
        sentMessages.push({ channelId, text })
      },
      collectTelemetryFn: async () => fakeSnapshot,
      runHousekeepingFn: async () => {
        housekeepingRuns += 1
        return {
          executedAt: new Date(t0).toISOString(),
          retentionDays: 30,
          walCheckpoint: {
            busy: 0,
            logFrames: 10,
            checkpointedFrames: 10,
            walBytesBefore: 4_000_000,
            walBytesAfter: 0,
            walReclaimedBytes: 4_000_000,
          },
          deletedBatchFiles: [],
          deletedLogFiles: ['old.log'],
          deletedTempFiles: [],
          deletedFilesCount: 1,
          reclaimedArtifactsBytes: 1_000_000,
          npmCacheCleaned: true,
          totalReclaimedBytes: 5_000_000,
        }
      },
    })

    expect(housekeepingRuns).toBe(1)
    expect(tick1.alertSent).toBe(true)
    expect(sentMessages).toHaveLength(1)
    expect(sentMessages[0].channelId).toBe('5555555555555555555')
    expect(sentMessages[0].text).toContain('Alfred VPS Erőforrás Figyelmeztetés')
    expect(sentMessages[0].text).toContain('Automatikus Housekeeping lefutott')

    // Second tick 1 minute later -> alert suppressed by cooldown
    const tick2 = await runResourceHeartbeatTick({
      agentsConfig: cfg,
      alertTracker: tracker,
      nowMs: t0 + 60_000,
      env: { DISCORD_CHANNEL_ALFRED_OPS: '5555555555555555555' },
      sendToDiscord: async (channelId, text) => {
        sentMessages.push({ channelId, text })
      },
      collectTelemetryFn: async () => fakeSnapshot,
      runHousekeepingFn: async () => {
        housekeepingRuns += 1
        return tick1.cleanupResult!
      },
    })
    expect(tick2.alertSent).toBe(false)
    expect(sentMessages).toHaveLength(1)

    const formatted = formatSystemAlertDiscordMessage(fakeSnapshot, tick1.cleanupResult)
    expect(formatted).toContain('Node RSS: 180 MB')
  })

  it('restricts system_storage tool strictly to alfred-ops', async () => {
    const db = getDb()
    const cfg = loadAlfredAgentsConfig({
      env: {
        DISCORD_CHANNEL_ALFRED_OPS: '5555555555555555555',
        DISCORD_CHANNEL_ALFRED_HQ: '1111111111111111111',
      },
      provisionWorkspaces: false,
    })
    const ops = cfg.agents.find((a) => a.id === 'alfred-ops')!
    const architect = cfg.agents.find((a) => a.id === 'alfred-architect')!

    await expect(
      executeWhitelistedToolAsync({ agent: architect, db }, 'system_storage', { action: 'status' }),
    ).rejects.toThrow(ToolNotAllowedError)

    const statusOut = await executeWhitelistedToolAsync(
      { agent: { ...ops, workspaceAbsPath: tempDir }, db },
      'system_storage',
      { action: 'status' },
    )
    const parsedStatus = JSON.parse(statusOut) as { ok: boolean; system: { memory: { totalMb: number } } }
    expect(parsedStatus.ok).toBe(true)
    expect(parsedStatus.system.memory.totalMb).toBeGreaterThan(0)

    const cleanupOut = await executeWhitelistedToolAsync(
      { agent: { ...ops, workspaceAbsPath: tempDir }, db },
      'system_storage',
      { action: 'cleanup' },
    )
    const parsedCleanup = JSON.parse(cleanupOut) as { ok: boolean; cleanup: { retentionDays: number } }
    expect(parsedCleanup.ok).toBe(true)
    expect(parsedCleanup.cleanup.retentionDays).toBe(30)
  })

  it('protects GET /api/admin/system and POST /api/admin/system/cleanup with DASHBOARD_TOKEN', async () => {
    const prevToken = process.env['DASHBOARD_TOKEN']
    process.env['DASHBOARD_TOKEN'] = 'test-secret-dashboard-token'
    try {
      // Unauthenticated GET /api/admin/system -> 401
      const unauthGet = mockReqRes('GET', '/api/admin/system')
      expect(await tryHandleAlfredVps(unauthGet.ctx)).toBe(true)
      expect(unauthGet.getStatus()).toBe(401)

      // Unauthenticated POST /api/admin/system/cleanup -> 401
      const unauthPost = mockReqRes('POST', '/api/admin/system/cleanup', { body: {} })
      expect(await tryHandleAlfredVps(unauthPost.ctx)).toBe(true)
      expect(unauthPost.getStatus()).toBe(401)

      // Wrong token -> 401
      const wrongTok = mockReqRes('GET', '/api/admin/system', {
        headers: { authorization: 'Bearer wrong-token' },
      })
      expect(await tryHandleAlfredVps(wrongTok.ctx)).toBe(true)
      expect(wrongTok.getStatus()).toBe(401)

      // Valid Bearer DASHBOARD_TOKEN on GET /api/admin/system -> 200
      const authGet = mockReqRes('GET', '/api/admin/system', {
        headers: { authorization: 'Bearer test-secret-dashboard-token' },
      })
      expect(await tryHandleAlfredVps(authGet.ctx)).toBe(true)
      expect(authGet.getStatus()).toBe(200)
      const getData = authGet.getJson()
      expect(getData['ok']).toBe(true)
      expect(getData['system']).toBeTruthy()

      // Valid X-Dashboard-Token on POST /api/admin/system/cleanup -> 200
      const authPost = mockReqRes('POST', '/api/admin/system/cleanup', {
        body: { forceNpmCacheClean: false },
        headers: { 'x-dashboard-token': 'test-secret-dashboard-token' },
      })
      expect(await tryHandleAlfredVps(authPost.ctx)).toBe(true)
      expect(authPost.getStatus()).toBe(200)
      const postData = authPost.getJson()
      expect(postData['ok']).toBe(true)
      expect(postData['cleanup']).toBeTruthy()
      expect(postData['system']).toBeTruthy()
    } finally {
      if (prevToken === undefined) {
        delete process.env['DASHBOARD_TOKEN']
      } else {
        process.env['DASHBOARD_TOKEN'] = prevToken
      }
    }
  })
})
