import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

// Must be set before startWebServer() runs so background tmux/channel pollers stay off.
process.env['WEB_ONLY'] = 'true'

import { WEB_PORT } from './config.js'
import { initDatabase } from './db.js'
import { logger } from './logger.js'
import { resolveAlfredRuntimeEnv } from './alfred/runtime-env.js'
import { startWebServer } from './web.js'

const runtimeEnv = resolveAlfredRuntimeEnv()
if (runtimeEnv.dbPath !== ':memory:') {
  mkdirSync(dirname(runtimeEnv.dbPath), { recursive: true })
}
initDatabase(runtimeEnv.dbPath)

const server = startWebServer(WEB_PORT)
logger.info({ port: WEB_PORT, dbPath: runtimeEnv.dbPath, mode: runtimeEnv.mode }, 'Alfred WEB_ONLY dashboard started')

function shutdown(signal: string): void {
  logger.info({ signal }, 'Stopping Alfred WEB_ONLY dashboard')
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
