import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { readEnvFile } from '../env.js'
import { logger } from '../logger.js'
import { AlfredDiscordGateway, bootAlfredCore, resolveAlfredRuntimeEnv } from './index.js'
import { startTestSimulatorServer } from './test-simulator.js'

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

  let cfg = bootAlfredCore({ env })
  if (!cfg) {
    logger.error('Alfred Core bootstrap failed; check ALFRED_AGENTS_CONFIG and SOUL.md paths')
    process.exit(1)
  }

  const simPortRaw = (env['ALFRED_SIM_PORT'] ?? '').trim()
  const simPort = simPortRaw ? Number(simPortRaw) : (runtimeEnv.mode === 'test' ? 3421 : 0)
  const simServer = simPort > 0
    ? startTestSimulatorServer({
      db,
      env,
      port: simPort,
      getAgentsConfig: () => cfg!,
      reloadAgentsConfig: () => {
        const next = bootAlfredCore({ env })
        if (next) cfg = next
        return cfg!
      },
    })
    : null

  const gateway = new AlfredDiscordGateway({
    db,
    agentsConfig: cfg,
    env,
    runtimeEnv,
    onFatalError: (err) => {
      logger.error({ error: sanitizeStartupError(err) }, 'Fatal Discord Gateway error; exiting')
      process.exit(1)
    },
  })

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Stopping Alfred Discord Gateway')
    gateway.stop()
    simServer?.close()
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

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

main().catch((err) => {
  logger.error({ error: sanitizeStartupError(err) }, 'Alfred runner failed to start')
  process.exit(1)
})
