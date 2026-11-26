import { mkdirSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type Database from 'better-sqlite3'
import { PROJECT_ROOT } from '../config.js'
import { initDatabase, getDb } from '../db.js'
import { readEnvFile } from '../env.js'
import { logger } from '../logger.js'
import { loadAlfredAgentsConfig } from './agents-config.js'
import { resolveToolOwnerModule } from './module-manager.js'
import {
  AlfredDiscordGateway,
  bootAlfredCore,
  checkCliProvidersHealth,
  checkpointSqliteWal,
  collectSystemTelemetry,
  createAlfredDiscordSender,
  formatSystemAlertDiscordMessage,
  isCliProvider,
  pollPendingBatches,
  prefixTestReply,
  recoverStuckBatchJobs,
  resolveAlfredRuntimeEnv,
  runHousekeeping,
  SystemAlertTracker,
  type AlfredAgentsConfig,
  type AlfredRuntimeEnv,
  type DiscordSendFn,
  type HousekeepingResult,
  type SystemTelemetrySnapshot,
} from './index.js'
import { startTestSimulatorServer } from './test-simulator.js'

export interface ResourceHeartbeatTickOptions {
  db?: Database.Database | null
  dbPath?: string
  env?: Record<string, string | undefined>
  runtimeEnv?: AlfredRuntimeEnv
  agentsConfig?: AlfredAgentsConfig | null
  alertTracker: SystemAlertTracker
  sendToDiscord?: DiscordSendFn
  projectRoot?: string
  nowMs?: number
  runRoutineWalCheckpoint?: boolean
  collectTelemetryFn?: typeof collectSystemTelemetry
  runHousekeepingFn?: typeof runHousekeeping
  pollPendingBatchesFn?: typeof pollPendingBatches
}

export interface ResourceHeartbeatTickResult {
  telemetry: SystemTelemetrySnapshot
  cleanupResult: HousekeepingResult | null
  alertSent: boolean
  opsChannelId: string | null
  alertMessage: string | null
  batchPollResult?: { polled: number; completed: number; failed: number; errors: Array<{ batchId: string; error: string }> } | null
}

function resolveOpsDiscordChannelId(
  agentsConfig: AlfredAgentsConfig | null | undefined,
  env: Record<string, string | undefined>,
): string | null {
  const opsAgent = agentsConfig?.agents.find((a) => a.id === 'alfred-ops')
  const fromAgent = opsAgent?.discordChannelId?.trim() ?? ''
  if (fromAgent && !fromAgent.startsWith('${')) {
    return fromAgent
  }
  const fromEnv = (env['DISCORD_CHANNEL_ALFRED_OPS'] ?? '').trim()
  if (fromEnv && !fromEnv.startsWith('${')) {
    return fromEnv
  }
  return null
}

/**
 * Executes a single resource-monitoring & housekeeping heartbeat cycle:
 * 1. Measures RAM, Swap, Node RSS, and SSD partition/directory usage.
 * 2. If SSD usage reaches `ALFRED_DISK_WARN_PCT` (`warn` or `crit`), automatically runs full Housekeeping
 *    (SQLite WAL checkpoint + expired batch/log/tmp cleanup + `npm cache clean --force`) and re-measures telemetry.
 *    Otherwise optionally performs a lightweight SQLite WAL checkpoint (`runRoutineWalCheckpoint`).
 * 3. If RAM or SSD still exceeds configured thresholds and the alert cooldown allows, sends a structured
 *    alert to `#alfred-ops`.
 */
export async function runResourceHeartbeatTick(
  opts: ResourceHeartbeatTickOptions,
): Promise<ResourceHeartbeatTickResult> {
  const env = opts.env ?? process.env
  const collectFn = opts.collectTelemetryFn ?? collectSystemTelemetry
  const housekeepingFn = opts.runHousekeepingFn ?? runHousekeeping

  let telemetry = await collectFn({
    projectRoot: opts.projectRoot,
    env,
  })
  let cleanupResult: HousekeepingResult | null = null

  if (telemetry.health.diskLevel !== 'ok') {
    cleanupResult = await housekeepingFn({
      db: opts.db,
      dbPath: opts.dbPath,
      projectRoot: opts.projectRoot,
      env,
      nowMs: opts.nowMs,
      diskUsedPct: telemetry.health.maxDiskUsedPct,
      diskWarnPct: telemetry.thresholds.diskWarnPct,
    })
    telemetry = await collectFn({
      projectRoot: opts.projectRoot,
      env,
    })
  } else if (opts.runRoutineWalCheckpoint && opts.db) {
    checkpointSqliteWal(opts.db, opts.dbPath)
  }

  const nowMs = opts.nowMs ?? Date.now()
  const shouldAlert = opts.alertTracker.shouldEmitAlert(
    telemetry.health.overallLevel,
    telemetry.thresholds.cooldownMs,
    nowMs,
  )

  const opsChannelId = resolveOpsDiscordChannelId(opts.agentsConfig, env)
  let alertSent = false
  let alertMessage: string | null = null

  if (shouldAlert) {
    const rawMsg = formatSystemAlertDiscordMessage(telemetry, cleanupResult)
    alertMessage = opts.runtimeEnv ? prefixTestReply(rawMsg, opts.runtimeEnv) : rawMsg
    if (opsChannelId && opts.sendToDiscord) {
      await opts.sendToDiscord(opsChannelId, alertMessage)
      opts.alertTracker.recordAlertSent(telemetry.health.overallLevel, nowMs)
      alertSent = true
    } else {
      opts.alertTracker.recordAlertSent(telemetry.health.overallLevel, nowMs)
    }
  }

  let batchPollResult: ResourceHeartbeatTickResult['batchPollResult'] = null
  const batchOwner = opts.db
    ? resolveToolOwnerModule('batch_submit', { db: opts.db, projectRoot: opts.projectRoot })
    : null
  if (opts.db && (!batchOwner || batchOwner.active)) {
    try {
      const pollFn = opts.pollPendingBatchesFn ?? pollPendingBatches
      batchPollResult = await pollFn({
        db: opts.db,
        projectRoot: opts.projectRoot,
        env,
        runtimeEnv: opts.runtimeEnv,
        agentsConfig: opts.agentsConfig,
        sendToDiscord: opts.sendToDiscord,
        nowSec: opts.nowMs ? Math.floor(opts.nowMs / 1000) : undefined,
      })
    } catch (err) {
      logger.warn({ err: sanitizeStartupError(err) }, 'Heartbeat pollPendingBatches failed (non-fatal)')
    }
  }

  return {
    telemetry,
    cleanupResult,
    alertSent,
    opsChannelId,
    alertMessage,
    batchPollResult,
  }
}

function resolveAgentsConfigFilePath(
  env: Record<string, string | undefined>,
  configPath?: string,
  projectRoot: string = PROJECT_ROOT,
): string {
  const raw = (configPath ?? env['ALFRED_AGENTS_CONFIG'] ?? '').trim()
  if (!raw) return join(projectRoot, 'config', 'agents.json')
  return isAbsolute(raw) ? resolve(raw) : resolve(projectRoot, raw)
}

/**
 * Lightweight mtimeMs-cached `config/agents.json` loader for a running `alfred-prod`/`alfred-test` process.
 * Allows toggling `enabled` or channel mappings from the Dashboard to take effect immediately on the next
 * Discord message without restarting the process or interrupting active sessions.
 */
export function createMtimeCachedAgentsConfigLoader(opts: {
  initialConfig: AlfredAgentsConfig
  env: Record<string, string | undefined>
  runtimeEnv?: AlfredRuntimeEnv
  configPath?: string
  projectRoot?: string
}): () => AlfredAgentsConfig {
  const projectRoot = opts.projectRoot ?? PROJECT_ROOT
  const filePath = resolveAgentsConfigFilePath(opts.env, opts.configPath, projectRoot)
  let cached = opts.initialConfig
  let lastMtimeMs: number | null = null
  try {
    lastMtimeMs = statSync(filePath).mtimeMs
  } catch {
    lastMtimeMs = null
  }

  return () => {
    let currentMtimeMs: number | null = null
    try {
      currentMtimeMs = statSync(filePath).mtimeMs
    } catch {
      return cached
    }
    if (currentMtimeMs === lastMtimeMs) {
      return cached
    }
    try {
      const reloaded = loadAlfredAgentsConfig({
        configPath: filePath,
        projectRoot,
        env: opts.env,
        provisionWorkspaces: false,
      })
      const enabledFilter = opts.runtimeEnv?.enabledAgentIds
      if (enabledFilter && enabledFilter.length > 0) {
        const allowSet = new Set(enabledFilter)
        reloaded.agents = reloaded.agents.filter((a) => allowSet.has(a.id))
      }
      cached = reloaded
      lastMtimeMs = currentMtimeMs
      logger.info(
        { configPath: filePath, activeAgents: reloaded.agents.map((a) => a.id) },
        'Reloaded config/agents.json after mtime change (live hot-reload)',
      )
    } catch (err) {
      logger.warn(
        { configPath: filePath, err: sanitizeStartupError(err) },
        'Failed to hot-reload config/agents.json; keeping last good snapshot',
      )
    }
    return cached
  }
}

function sanitizeStartupError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg
    .replace(/Bot\s+[A-Za-z0-9._-]+/g, 'Bot [REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [REDACTED]')
    .replace(/ya29\.[A-Za-z0-9._-]+/g, '[REDACTED_TOKEN]')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-[REDACTED]')
}

async function main(): Promise<void> {
  const env = { ...readEnvFile(), ...process.env }
  const runtimeEnv = resolveAlfredRuntimeEnv(env)

  if (runtimeEnv.dbPath !== ':memory:') {
    mkdirSync(dirname(runtimeEnv.dbPath), { recursive: true })
  }
  initDatabase(runtimeEnv.dbPath)
  const db = getDb()

  try {
    const rec = recoverStuckBatchJobs(db)
    if (rec.recoveredDownloadingJobs > 0 || rec.cleanedOrphanHolds > 0) {
      logger.info(rec, 'Recovered stuck batch jobs / orphaned heavy-job-holds on startup')
    }
  } catch (err) {
    logger.warn({ err: sanitizeStartupError(err) }, 'Batch startup crash-recovery failed (non-fatal)')
  }

  let cfg = bootAlfredCore({ env })
  if (!cfg) {
    logger.error('Alfred Core bootstrap failed; check ALFRED_AGENTS_CONFIG and SOUL.md paths')
    process.exit(1)
  }

  const getLatestAgentsConfig = createMtimeCachedAgentsConfigLoader({
    initialConfig: cfg,
    env,
    runtimeEnv,
  })

  try {
    const cliHealth = await checkCliProvidersHealth({ env, timeoutMs: 3_000 })
    logger.info({ cliProviders: cliHealth }, 'Headless CLI providers pre-flight health check')
    for (const ag of cfg.agents) {
      if (!isCliProvider(ag.provider)) continue
      const status = cliHealth.find((h) => h.provider === ag.provider)
      if (status && (!status.installed || !status.authConfigured)) {
        logger.warn(
          {
            agentId: ag.id,
            provider: ag.provider,
            installed: status.installed,
            authConfigured: status.authConfigured,
            binary: status.binary,
          },
          'Configured CLI provider for agent is missing binary or authentication',
        )
      }
    }
  } catch (err) {
    logger.warn({ err: sanitizeStartupError(err) }, 'Headless CLI pre-flight health check failed')
  }

  const simPortRaw = (env['ALFRED_SIM_PORT'] ?? '').trim()
  const simPort = simPortRaw ? Number(simPortRaw) : (runtimeEnv.mode === 'test' ? 3421 : 0)
  const simServer = simPort > 0
    ? startTestSimulatorServer({
      db,
      env,
      port: simPort,
      getAgentsConfig: () => getLatestAgentsConfig(),
      reloadAgentsConfig: () => {
        const next = bootAlfredCore({ env })
        if (next) cfg = next
        return getLatestAgentsConfig()
      },
    })
    : null

  const simOnly = env['ALFRED_SIM_ONLY'] === 'true'
  const gateway = simOnly
    ? null
    : new AlfredDiscordGateway({
      db,
      agentsConfig: cfg,
      getAgentsConfig: getLatestAgentsConfig,
      env,
      runtimeEnv,
      onFatalError: (err) => {
        logger.error({ error: sanitizeStartupError(err) }, 'Fatal Discord Gateway error; exiting')
        process.exit(1)
      },
    })

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Stopping Alfred Discord Gateway')
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
    gateway?.stop()
    simServer?.close()
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  const alertTracker = new SystemAlertTracker()
  const rawInterval = (env['ALFRED_MONITOR_INTERVAL_MS'] ?? '').trim()
  const parsedInterval = rawInterval ? Number(rawInterval) : NaN
  const monitorIntervalMs =
    Number.isFinite(parsedInterval) && parsedInterval >= 10_000 ? Math.round(parsedInterval) : 300_000
  const canSendDiscordAlerts = !simOnly && Boolean((env['DISCORD_BOT_TOKEN'] ?? '').trim())
  const discordSender = canSendDiscordAlerts ? createAlfredDiscordSender(env) : undefined
  let heartbeatTickCounter = 0

  const executeHeartbeat = async () => {
    heartbeatTickCounter += 1
    try {
      const res = await runResourceHeartbeatTick({
        db,
        dbPath: runtimeEnv.dbPath,
        env,
        runtimeEnv,
        agentsConfig: getLatestAgentsConfig(),
        alertTracker,
        sendToDiscord: discordSender,
        runRoutineWalCheckpoint: heartbeatTickCounter % 6 === 1,
      })
      if (res.telemetry.health.overallLevel !== 'ok') {
        logger.warn(
          {
            level: res.telemetry.health.overallLevel,
            reasons: res.telemetry.health.reasons,
            alertSent: res.alertSent,
            reclaimedBytes: res.cleanupResult?.totalReclaimedBytes ?? 0,
          },
          'System resource threshold exceeded during heartbeat check',
        )
      }
    } catch (err) {
      logger.warn({ err: sanitizeStartupError(err) }, 'Resource heartbeat check failed')
    }
  }

  let heartbeatTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
    void executeHeartbeat()
  }, monitorIntervalMs)
  heartbeatTimer.unref?.()
  void executeHeartbeat()

  if (!gateway) {
    logger.info(
      { alfredEnv: runtimeEnv.mode, dbPath: runtimeEnv.dbPath, simPort, simOnly: true },
      'Alfred running in simulated-Discord test mode (real Discord Gateway disabled)',
    )
    return
  }

  const ready = await gateway.start()
  logger.info(
    {
      alfredEnv: runtimeEnv.mode,
      dbPath: runtimeEnv.dbPath,
      budgetMultiplier: runtimeEnv.budgetMultiplier,
      enabledAgents: cfg.agents.map((a) => a.id),
      botUsername: ready.botUsername,
      botUserId: ready.botUserId,
      channels: cfg.agents.map((a) => ({
        id: a.id,
        channelName: a.channelName,
        discordChannelId: a.discordChannelId,
        provider: a.provider,
        model: a.model,
      })),
    },
    'Alfred Discord Gateway is online and listening',
  )
}

const isDirectRun =
  typeof process.argv[1] === 'string' &&
  fileURLToPath(import.meta.url).replace(/\\/g, '/').toLowerCase() ===
    process.argv[1].replace(/\\/g, '/').toLowerCase()

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ error: sanitizeStartupError(err) }, 'Alfred runner failed to start')
    process.exit(1)
  })
}
