import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { PROJECT_ROOT } from '../config.js'
import { getDb, getInstalledModuleRow, upsertInstalledModuleRow } from '../db.js'
import { readEnvFile } from '../env.js'
import { parseEnvContent } from '../env-parse.js'
import { atomicWriteFileSync } from '../web/atomic-write.js'
import { deleteSecret, getSecret, listSecrets, setSecret } from '../web/vault.js'
import {
  enableModule,
  evaluateWizardReadiness,
  installAgentPackage,
  listAgentPackages,
  listModules,
  parseModuleConfigJson,
  toggleAgentPackage,
  type ModuleManagerOptions,
  type ModuleSetupWizardSchema,
  type ModuleStatusView,
  type ModuleWizardField,
  type ModuleWizardStep,
} from './module-manager.js'
import { resolveVertexEuAuth } from './vertex-auth.js'
import { probeCloudStorageForWizard } from './cloud-storage.js'

export type ModuleWizardErrorCode =
  | 'INVALID_ID'
  | 'MODULE_NOT_FOUND'
  | 'WIZARD_NOT_SUPPORTED'
  | 'UNKNOWN_WIZARD_FIELD'
  | 'INVALID_WIZARD_VALUE'
  | 'FORBIDDEN_ENV_KEY'

export class ModuleWizardError extends Error {
  public readonly code: ModuleWizardErrorCode
  public readonly statusHttp: 400 | 404 | 409
  public readonly details?: Record<string, unknown>

  constructor(
    code: ModuleWizardErrorCode,
    statusHttp: 400 | 404 | 409,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ModuleWizardError'
    this.code = code
    this.statusHttp = statusHttp
    this.details = details
  }
}

/**
 * System-critical `.env` keys that a module setup wizard is STRICTLY forbidden from modifying,
 * even if a manifest ever attempted to declare them.
 */
export const FORBIDDEN_WIZARD_ENV_KEYS: ReadonlySet<string> = new Set([
  'PATH',
  'NODE_OPTIONS',
  'DASHBOARD_TOKEN',
  'ALFRED_ENV',
  'WEB_ONLY',
  'PORT',
  'WEB_PORT',
  'WEB_HOST',
  'HOME',
  'USER',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'VAULT_KEY_STORE',
  'ALFRED_DB_PATH',
  'ALFRED_AGENTS_CONFIG',
  'ALFRED_WORKSPACES_DIR',
  'ALLOWED_USER_IDS',
  'DISCORD_BOT_TOKEN',
])

const SAFE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const SAFE_ENV_KEY_RE = /^[A-Z][A-Z0-9_]{1,63}$/

export interface WizardVaultOps {
  listSecrets: () => Array<{ id: string; label?: string }>
  setSecret: (id: string, label: string, value: string) => void
  getSecret: (id: string) => string | null
  deleteSecret: (id: string) => boolean
}

const DEFAULT_VAULT_OPS: WizardVaultOps = {
  listSecrets,
  setSecret,
  getSecret,
  deleteSecret,
}

export interface ModuleWizardOptions extends ModuleManagerOptions {
  /** Optional explicit `.env` file path override (for isolated unit tests) */
  envFilePath?: string
  /** Optional additional SQLite DB paths for split-brain sync of `installed_modules.config_json` */
  targetDbPaths?: string[]
  /** Optional Vault operations override (for isolated unit tests) */
  vaultOps?: WizardVaultOps
  /** Optional fetch implementation override for live probe tests */
  fetchImpl?: typeof fetch
}

export interface WizardFieldStateView extends ModuleWizardField {
  isSet: boolean
  /** Present ONLY for non-secret fields; NEVER populated for `type === 'secret'` / `storage === 'vault'` */
  value?: string | number | boolean | null
}

export interface WizardStepStateView extends Omit<ModuleWizardStep, 'fields'> {
  completed: boolean
  setCount: number
  fields?: WizardFieldStateView[]
}

export interface ModuleWizardState {
  moduleId: string
  moduleName: string
  moduleState: ModuleStatusView['state']
  title: string
  summary: string
  testAction?: string
  docChapter?: string
  configured: boolean
  needsSetup: boolean
  completedSteps: string[]
  missingRequirements: string[]
  steps: WizardStepStateView[]
}

export interface SaveWizardPayload {
  stepId?: string
  values?: Record<string, unknown>
  /** Explicit keys to delete from Vault / config_json / env */
  clearKeys?: string[]
}

export interface WizardTestCheck {
  label: string
  ok: boolean
  detail: string
}

export interface WizardTestResult {
  ok: boolean
  testAction: string
  checks: WizardTestCheck[]
}

function assertValidModuleId(rawId: string): string {
  const id = String(rawId || '').trim()
  if (!SAFE_ID_RE.test(id)) {
    throw new ModuleWizardError('INVALID_ID', 400, `Invalid module id "${rawId}"`)
  }
  return id
}

function resolveProjectRoot(opts?: ModuleWizardOptions): string {
  return resolve(opts?.projectRoot ?? PROJECT_ROOT)
}

function resolveEnvFilePath(opts?: ModuleWizardOptions): string {
  if (opts?.envFilePath) return resolve(opts.envFilePath)
  const root = resolveProjectRoot(opts)
  return join(root, '.env')
}

function readEnvMapForWizard(opts?: ModuleWizardOptions): Record<string, string | undefined> {
  if (opts?.env) return opts.env
  const envFile = resolveEnvFilePath(opts)
  let fromFile: Record<string, string> = {}
  if (existsSync(envFile)) {
    try {
      fromFile = parseEnvContent(readFileSync(envFile, 'utf-8'))
    } catch {
      fromFile = {}
    }
  } else {
    try {
      fromFile = readEnvFile()
    } catch {
      fromFile = {}
    }
  }
  return { ...fromFile, ...process.env }
}

function resolveDb(opts?: ModuleWizardOptions): Database.Database {
  const db = opts?.db ?? getDb()
  db.exec(`
    CREATE TABLE IF NOT EXISTS installed_modules (
      module_id TEXT PRIMARY KEY,
      state TEXT NOT NULL CHECK(state IN ('available', 'installed_disabled', 'active')),
      installed_at TEXT,
      updated_at TEXT,
      config_json TEXT
    )
  `)
  return db
}

function resolvePresentVaultAndEnvIds(
  env: Record<string, string | undefined>,
  vaultOps: WizardVaultOps,
  secretIdsOverride?: ReadonlySet<string>,
): { vaultIds: Set<string>; combinedIds: Set<string> } {
  const vaultIds = new Set<string>()
  if (secretIdsOverride) {
    for (const id of secretIdsOverride) vaultIds.add(id)
  } else {
    try {
      for (const entry of vaultOps.listSecrets()) {
        if (entry?.id) vaultIds.add(entry.id)
      }
    } catch {
      // Vault unreadable/empty
    }
  }
  const combinedIds = new Set<string>(vaultIds)
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string' && v.trim().length > 0) {
      combinedIds.add(k)
    }
  }
  return { vaultIds, combinedIds }
}

function loadModuleWithWizard(
  moduleId: string,
  opts?: ModuleWizardOptions,
): { mod: ModuleStatusView; wizard: ModuleSetupWizardSchema } {
  const id = assertValidModuleId(moduleId)
  const vaultOps = opts?.vaultOps ?? DEFAULT_VAULT_OPS
  const env = readEnvMapForWizard(opts)
  const { combinedIds } = resolvePresentVaultAndEnvIds(env, vaultOps, opts?.secretIds)
  const modules = listModules({
    ...opts,
    env,
    secretIds: combinedIds,
  })
  const mod = modules.find((m) => m.id === id)
  if (!mod) {
    throw new ModuleWizardError('MODULE_NOT_FOUND', 404, `Module not found: ${id}`)
  }
  if (!mod.setupWizard) {
    throw new ModuleWizardError(
      'WIZARD_NOT_SUPPORTED',
      404,
      `Module "${id}" does not define a declarative setupWizard schema`,
    )
  }
  return { mod, wizard: mod.setupWizard }
}

function allWizardFieldsByKey(wizard: ModuleSetupWizardSchema): Map<string, ModuleWizardField> {
  const map = new Map<string, ModuleWizardField>()
  for (const step of wizard.steps) {
    for (const f of step.fields ?? []) {
      map.set(f.key, f)
    }
  }
  return map
}

function upsertEnvKeysAtomically(
  envFilePath: string,
  updates: Record<string, string | null>,
): boolean {
  let existingText = ''
  if (existsSync(envFilePath)) {
    existingText = readFileSync(envFilePath, 'utf-8')
  }
  const existingMap = parseEnvContent(existingText)
  let changed = false

  for (const [k, v] of Object.entries(updates)) {
    const prev = (existingMap[k] ?? '').trim()
    const next = v === null ? '' : v.trim()
    if (prev !== next) {
      changed = true
    }
  }
  if (!changed) return false

  const lines = existingText ? existingText.replace(/\r\n/g, '\n').split('\n') : []
  const handled = new Set<string>()
  const outLines: string[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    const match = /^([A-Z][A-Z0-9_]*)=/.exec(trimmed)
    if (match && Object.prototype.hasOwnProperty.call(updates, match[1])) {
      const key = match[1]
      handled.add(key)
      const val = updates[key]
      if (val !== null && val !== '') {
        outLines.push(`${key}=${val}`)
      }
      // If null/empty, omit line to clear it cleanly
      continue
    }
    outLines.push(line)
  }

  for (const [key, val] of Object.entries(updates)) {
    if (handled.has(key)) continue
    if (val !== null && val !== '') {
      outLines.push(`${key}=${val}`)
    }
  }

  // Ensure trailing newline
  while (outLines.length > 0 && outLines[outLines.length - 1] === '') {
    outLines.pop()
  }
  const finalContent = outLines.join('\n') + (outLines.length > 0 ? '\n' : '')
  mkdirSync(dirname(envFilePath), { recursive: true })
  atomicWriteFileSync(envFilePath, finalContent, { mode: 0o600 })
  return true
}

function syncConfigRowToTargetDbs(
  sourceDb: Database.Database,
  moduleId: string,
  targetDbPaths: readonly string[] | undefined,
): void {
  if (!targetDbPaths || targetDbPaths.length === 0) return
  const row = getInstalledModuleRow(moduleId, sourceDb)
  if (!row) return

  const sourcePathNorm =
    typeof sourceDb.name === 'string' && sourceDb.name && sourceDb.name !== ':memory:'
      ? resolve(sourceDb.name)
      : null

  for (const rawPath of targetDbPaths) {
    if (!rawPath || rawPath === ':memory:') continue
    const abs = resolve(rawPath)
    if (sourcePathNorm && abs === sourcePathNorm) continue
    if (!existsSync(abs)) continue
    let targetDb: Database.Database | null = null
    try {
      targetDb = new Database(abs, { fileMustExist: true })
      targetDb.exec(`
        CREATE TABLE IF NOT EXISTS installed_modules (
          module_id TEXT PRIMARY KEY,
          state TEXT NOT NULL CHECK(state IN ('available', 'installed_disabled', 'active')),
          installed_at TEXT,
          updated_at TEXT,
          config_json TEXT
        )
      `)
      upsertInstalledModuleRow(row, targetDb)
    } catch {
      // Best-effort split-DB sync
    } finally {
      targetDb?.close()
    }
  }
}

/**
 * Reads a module's `setupWizard` schema and computes its live field/step state
 * WITHOUT ever calling `getSecret()` (decryption-free, 0 secret exposure).
 */
export function getModuleWizardState(
  moduleId: string,
  opts?: ModuleWizardOptions,
): ModuleWizardState {
  const { mod, wizard } = loadModuleWithWizard(moduleId, opts)
  const vaultOps = opts?.vaultOps ?? DEFAULT_VAULT_OPS
  const env = readEnvMapForWizard(opts)
  const { combinedIds } = resolvePresentVaultAndEnvIds(env, vaultOps, opts?.secretIds)

  let configObj: Record<string, unknown> = {}
  try {
    const db = opts?.db ?? getDb()
    const row = getInstalledModuleRow(mod.id, db)
    configObj = parseModuleConfigJson(row?.config_json)
  } catch {
    configObj = {}
  }

  const readiness = evaluateWizardReadiness(wizard, combinedIds, configObj, env)
  const completedSet = new Set(readiness.completedSteps)

  const steps: WizardStepStateView[] = wizard.steps.map((step) => {
    let setCount = 0
    const fields: WizardFieldStateView[] | undefined = step.fields?.map((f) => {
      if (f.type === 'secret' || f.storage === 'vault') {
        const isSet = combinedIds.has(f.key)
        if (isSet) setCount += 1
        // NEVER return raw secret value!
        return { ...f, isSet }
      }
      if (f.storage === 'config_json') {
        const fromCfg = configObj[f.key]
        const fromEnv = env[f.key]
        const effective =
          fromCfg !== undefined && fromCfg !== null && String(fromCfg).trim() !== ''
            ? fromCfg
            : typeof fromEnv === 'string' && fromEnv.trim() !== ''
              ? fromEnv.trim()
              : (f.defaultValue ?? null)
        const isSet = effective !== null && effective !== undefined && String(effective).trim() !== ''
        if (isSet) setCount += 1
        return { ...f, isSet, value: effective as string | number | boolean | null }
      }
      if (f.storage === 'env') {
        const envVal = (env[f.key] ?? '').trim()
        const isSet = envVal.length > 0
        if (isSet) setCount += 1
        return { ...f, isSet, value: isSet ? envVal : (f.defaultValue ?? '') }
      }
      // storage === 'action'
      const savedAction = configObj[`_action_${f.key}`]
      const val =
        typeof savedAction === 'boolean'
          ? savedAction
          : typeof f.defaultValue === 'boolean'
            ? f.defaultValue
            : true
      return { ...f, isSet: true, value: val }
    })

    return {
      id: step.id,
      title: step.title,
      description: step.description,
      ...(step.type ? { type: step.type } : {}),
      ...(step.requirementMode ? { requirementMode: step.requirementMode } : {}),
      completed: step.type === 'verify_and_activate' ? readiness.configured : completedSet.has(step.id),
      setCount,
      ...(fields ? { fields } : {}),
    }
  })

  return {
    moduleId: mod.id,
    moduleName: mod.name,
    moduleState: mod.state,
    title: wizard.title,
    summary: wizard.summary,
    ...(wizard.testAction ? { testAction: wizard.testAction } : {}),
    ...(wizard.docChapter ? { docChapter: wizard.docChapter } : {}),
    configured: readiness.configured,
    needsSetup: readiness.needsSetup,
    completedSteps: readiness.completedSteps,
    missingRequirements: readiness.missingRequirements,
    steps,
  }
}

/**
 * Validates and persists wizard field values across Vault (`storage: 'vault'`),
 * SQLite `installed_modules.config_json` (`storage: 'config_json'`), and strictly
 * whitelisted `.env` keys (`storage: 'env'`).
 */
export function saveModuleWizardStep(
  moduleId: string,
  payload: SaveWizardPayload,
  opts?: ModuleWizardOptions,
): { ok: true; state: ModuleWizardState; restartRequired: boolean } {
  const { mod, wizard } = loadModuleWithWizard(moduleId, opts)
  const db = resolveDb(opts)
  const vaultOps = opts?.vaultOps ?? DEFAULT_VAULT_OPS
  const fieldMap = allWizardFieldsByKey(wizard)

  const values = payload?.values && typeof payload.values === 'object' && !Array.isArray(payload.values)
    ? payload.values
    : {}
  const clearKeys = Array.isArray(payload?.clearKeys)
    ? payload.clearKeys.map((k) => String(k || '').trim()).filter(Boolean)
    : []

  // 1. Strict schema validation on all submitted keys
  for (const key of [...Object.keys(values), ...clearKeys]) {
    if (!fieldMap.has(key)) {
      throw new ModuleWizardError(
        'UNKNOWN_WIZARD_FIELD',
        400,
        `Unknown wizard field "${key}" for module "${mod.id}"`,
        { field: key, moduleId: mod.id },
      )
    }
  }

  // 2. Validate values against field types, forbidden env keys, and validationRegex
  const envUpdates: Record<string, string | null> = {}
  const configUpdates: Record<string, unknown> = {}
  const vaultWrites: Array<{ key: string; label: string; value: string }> = []
  const vaultDeletes: string[] = []

  for (const key of clearKeys) {
    const field = fieldMap.get(key)!
    if (field.storage === 'vault') {
      vaultDeletes.push(key)
    } else if (field.storage === 'config_json') {
      configUpdates[key] = null
    } else if (field.storage === 'env') {
      if (FORBIDDEN_WIZARD_ENV_KEYS.has(key) || !SAFE_ENV_KEY_RE.test(key)) {
        throw new ModuleWizardError(
          'FORBIDDEN_ENV_KEY',
          400,
          `Modifying system-critical env key "${key}" is strictly forbidden`,
          { field: key },
        )
      }
      envUpdates[key] = null
    }
  }

  for (const [key, rawVal] of Object.entries(values)) {
    const field = fieldMap.get(key)!

    if (field.storage === 'vault') {
      if (rawVal === null || rawVal === undefined) continue
      const strVal = String(rawVal).trim()
      // Empty string keeps existing secret unchanged (only explicit clearKeys deletes)
      if (!strVal) continue
      if (field.validationRegex) {
        const re = new RegExp(field.validationRegex)
        if (!re.test(strVal)) {
          throw new ModuleWizardError(
            'INVALID_WIZARD_VALUE',
            400,
            `Invalid value for "${field.label}" (${key})`,
            { field: key },
          )
        }
      }
      vaultWrites.push({ key, label: field.label || key, value: strVal })
      continue
    }

    if (field.storage === 'env') {
      if (FORBIDDEN_WIZARD_ENV_KEYS.has(key) || !SAFE_ENV_KEY_RE.test(key)) {
        throw new ModuleWizardError(
          'FORBIDDEN_ENV_KEY',
          400,
          `Modifying system-critical env key "${key}" is strictly forbidden`,
          { field: key },
        )
      }
      const strVal = rawVal === null || rawVal === undefined ? '' : String(rawVal).trim()
      if (/[\r\n\0]/.test(strVal)) {
        throw new ModuleWizardError(
          'INVALID_WIZARD_VALUE',
          400,
          `Control characters are not allowed in "${field.label}" (${key})`,
          { field: key },
        )
      }
      if (strVal && field.validationRegex) {
        const re = new RegExp(field.validationRegex)
        if (!re.test(strVal)) {
          throw new ModuleWizardError(
            'INVALID_WIZARD_VALUE',
            400,
            `Invalid value for "${field.label}" (${key}): expected format ${field.validationRegex}`,
            { field: key },
          )
        }
      }
      if (strVal) {
        envUpdates[key] = strVal
      } else if (field.required === true) {
        throw new ModuleWizardError(
          'INVALID_WIZARD_VALUE',
          400,
          `Field "${field.label}" (${key}) is required`,
          { field: key },
        )
      } else {
        envUpdates[key] = null
      }
      continue
    }

    if (field.storage === 'config_json') {
      if (field.type === 'number') {
        if (rawVal === '' || rawVal === null || rawVal === undefined) {
          configUpdates[key] = null
        } else {
          const num = Number(rawVal)
          if (!Number.isFinite(num)) {
            throw new ModuleWizardError('INVALID_WIZARD_VALUE', 400, `Field "${field.label}" must be a number`, { field: key })
          }
          configUpdates[key] = num
        }
      } else if (field.type === 'boolean') {
        configUpdates[key] = Boolean(rawVal)
      } else {
        const strVal = rawVal === null || rawVal === undefined ? '' : String(rawVal).trim()
        if (strVal && field.type === 'select' && field.options && field.options.length > 0) {
          const allowed = new Set(field.options.map((o) => o.value))
          if (!allowed.has(strVal)) {
            throw new ModuleWizardError('INVALID_WIZARD_VALUE', 400, `Invalid option for "${field.label}"`, { field: key })
          }
        }
        if (strVal && field.validationRegex) {
          const re = new RegExp(field.validationRegex)
          if (!re.test(strVal)) {
            throw new ModuleWizardError('INVALID_WIZARD_VALUE', 400, `Invalid value for "${field.label}" (${key})`, { field: key })
          }
        }
        configUpdates[key] = strVal || null
      }
      continue
    }

    if (field.storage === 'action') {
      configUpdates[`_action_${key}`] = Boolean(rawVal)
    }
  }

  // 3. Apply Vault mutations (never logging secret values)
  for (const delKey of vaultDeletes) {
    vaultOps.deleteSecret(delKey)
  }
  for (const w of vaultWrites) {
    vaultOps.setSecret(w.key, w.label, w.value)
  }

  // 4. Apply atomic SQLite config_json merge + split-DB sync
  if (Object.keys(configUpdates).length > 0) {
    const nowIso = new Date().toISOString()
    const existingRow = getInstalledModuleRow(mod.id, db)
    const mergedCfg = parseModuleConfigJson(existingRow?.config_json)
    for (const [k, v] of Object.entries(configUpdates)) {
      if (v === null) {
        delete mergedCfg[k]
      } else {
        mergedCfg[k] = v
      }
    }
    upsertInstalledModuleRow(
      {
        module_id: mod.id,
        state: existingRow?.state ?? (mod.builtIn ? 'active' : mod.defaultEnabled ? 'active' : 'available'),
        installed_at: existingRow?.installed_at ?? nowIso,
        updated_at: nowIso,
        config_json: JSON.stringify(mergedCfg),
      },
      db,
    )
    syncConfigRowToTargetDbs(db, mod.id, opts?.targetDbPaths)
  }

  // 5. Apply whitelisted `.env` updates atomically (respecting ALFRED_ENV === 'test' isolation)
  let restartRequired = false
  if (Object.keys(envUpdates).length > 0) {
    const envFilePath = resolveEnvFilePath(opts)
    restartRequired = upsertEnvKeysAtomically(envFilePath, envUpdates)
    // Refresh in-memory env map if caller passed an explicit env object
    if (opts?.env) {
      for (const [k, v] of Object.entries(envUpdates)) {
        if (v === null) delete opts.env[k]
        else opts.env[k] = v
      }
    }
  }

  const nextState = getModuleWizardState(mod.id, {
    ...opts,
    db,
    secretIds: undefined, // re-read fresh Vault metadata
  })
  return { ok: true, state: nextState, restartRequired }
}

type WizardProbeHandler = (
  mod: ModuleStatusView,
  opts: ModuleWizardOptions,
) => Promise<WizardTestCheck[]>

const WIZARD_PROBE_HANDLERS: Record<string, WizardProbeHandler> = {
  batch_provider_probe: async (mod, opts) => {
    const vaultOps = opts.vaultOps ?? DEFAULT_VAULT_OPS
    const env = readEnvMapForWizard(opts)
    const fetchImpl = opts.fetchImpl ?? fetch

    let configObj: Record<string, unknown> = {}
    try {
      const db = opts.db ?? getDb()
      configObj = parseModuleConfigJson(getInstalledModuleRow(mod.id, db)?.config_json)
    } catch {
      configObj = {}
    }

    const resolveKey = (key: string): string => {
      try {
        const fromVault = vaultOps.getSecret(key)
        if (typeof fromVault === 'string' && fromVault.trim()) return fromVault.trim()
      } catch {
        // Vault unavailable: fallback to env
      }
      return (env[key] ?? '').trim()
    }

    const geminiKey = resolveKey('GEMINI_API_KEY')
    const anthropicKey = resolveKey('ANTHROPIC_API_KEY')
    const openaiKey = resolveKey('OPENAI_API_KEY')
    const vertexBucket = String(configObj['VERTEX_EU_BATCH_BUCKET'] ?? env['VERTEX_EU_BATCH_BUCKET'] ?? '')
      .trim()
      .replace(/^gs:\/\//, '')
      .replace(/\/+$/, '')

    const checks: WizardTestCheck[] = []

    if (geminiKey) {
      try {
        const resp = await fetchImpl('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', {
          method: 'GET',
          headers: { 'x-goog-api-key': geminiKey },
          signal: AbortSignal.timeout(8_000),
        })
        checks.push({
          label: 'Google Gemini Batch',
          ok: resp.ok,
          detail: resp.ok ? 'Hitelesítés OK (0 token)' : `HTTP ${resp.status}`,
        })
      } catch (err) {
        checks.push({
          label: 'Google Gemini Batch',
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        })
      }
    }

    if (anthropicKey) {
      try {
        const baseUrl = (env['ANTHROPIC_BASE_URL'] ?? 'https://api.anthropic.com').replace(/\/+$/, '')
        const resp = await fetchImpl(`${baseUrl}/v1/models?limit=1`, {
          method: 'GET',
          headers: {
            'x-api-key': anthropicKey,
            'anthropic-version': '2023-06-01',
          },
          signal: AbortSignal.timeout(8_000),
        })
        checks.push({
          label: 'Anthropic Claude Batch',
          ok: resp.ok,
          detail: resp.ok ? 'Hitelesítés OK (0 token)' : `HTTP ${resp.status}`,
        })
      } catch (err) {
        checks.push({
          label: 'Anthropic Claude Batch',
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        })
      }
    }

    if (openaiKey) {
      try {
        const baseUrl = (env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1').replace(/\/+$/, '')
        const resp = await fetchImpl(`${baseUrl}/models`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${openaiKey}` },
          signal: AbortSignal.timeout(8_000),
        })
        checks.push({
          label: 'OpenAI Batch',
          ok: resp.ok,
          detail: resp.ok ? 'Hitelesítés OK (0 token)' : `HTTP ${resp.status}`,
        })
      } catch (err) {
        checks.push({
          label: 'OpenAI Batch',
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        })
      }
    }

    if (vertexBucket) {
      try {
        const auth = await resolveVertexEuAuth({
          env,
          projectRoot: resolveProjectRoot(opts),
          fetchImpl,
        })
        const resp = await fetchImpl(
          `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(vertexBucket)}?fields=location`,
          {
            method: 'GET',
            headers: { Authorization: `Bearer ${auth.accessToken}` },
            signal: AbortSignal.timeout(8_000),
          },
        )
        if (resp.ok) {
          const meta = (await resp.json()) as { location?: string }
          checks.push({
            label: 'Vertex EU GCS Bucket',
            ok: true,
            detail: `Elérhető (${vertexBucket}, régió: ${meta.location ?? 'EU'})`,
          })
        } else {
          checks.push({
            label: 'Vertex EU GCS Bucket',
            ok: false,
            detail: `GCS bucket HTTP ${resp.status}`,
          })
        }
      } catch (err) {
        checks.push({
          label: 'Vertex EU GCS Bucket',
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        })
      }
    }

    if (checks.length === 0) {
      checks.push({
        label: 'Batch szolgáltató',
        ok: false,
        detail: 'Egyetlen Batch szolgáltató (Gemini, Anthropic, OpenAI vagy Vertex EU) sincs még beállítva.',
      })
    }

    return checks
  },
  cloud_storage_probe: async (_mod, opts) => {
    return probeCloudStorageForWizard({
      db: opts.db,
      env: readEnvMapForWizard(opts),
      projectRoot: resolveProjectRoot(opts),
      vaultOps: opts.vaultOps,
      fetchImpl: opts.fetchImpl,
    })
  },
}

/**
 * Executes the module's registered lightweight 0-token probe (`testAction`).
 */
export async function testModuleWizardConfig(
  moduleId: string,
  opts?: ModuleWizardOptions,
): Promise<WizardTestResult> {
  const { mod, wizard } = loadModuleWithWizard(moduleId, opts)
  const testAction = wizard.testAction ?? 'default'
  const handler = WIZARD_PROBE_HANDLERS[testAction]
  if (!handler) {
    const state = getModuleWizardState(mod.id, opts)
    return {
      ok: state.configured,
      testAction,
      checks: [
        {
          label: 'Konfiguráció teljessége',
          ok: state.configured,
          detail: state.configured
            ? 'Minden kötelező lépés kitöltve.'
            : `Hiányzó beállítások: ${state.missingRequirements.join(', ')}`,
        },
      ],
    }
  }
  const checks = await handler(mod, opts ?? {})
  const anyPassing = checks.some((c) => c.ok)
  return {
    ok: anyPassing,
    testAction,
    checks,
  }
}

/**
 * Completes the wizard: activates the module via `enableModule`, optionally enables/installs
 * the linked specialist agent package (`toggleAgentPackage(..., true)`), and returns the updated state.
 */
export function completeModuleWizard(
  moduleId: string,
  opts?: ModuleWizardOptions & { enableAgent?: boolean; restartRequired?: boolean },
): {
  ok: true
  module: ModuleStatusView
  state: ModuleWizardState
  enabledAgentId: string | null
  restartRequired: boolean
} {
  const { mod, wizard } = loadModuleWithWizard(moduleId, opts)
  const db = resolveDb(opts)
  const env = readEnvMapForWizard(opts)
  const enabledRes = enableModule(mod.id, {
    ...opts,
    db,
    env,
    withDependencies: true,
  })
  syncConfigRowToTargetDbs(db, mod.id, opts?.targetDbPaths)

  // Determine whether an action field targets a specialist agent
  let targetAgentId: string | null = null
  let shouldEnableAgent = opts?.enableAgent
  const configObj = parseModuleConfigJson(getInstalledModuleRow(mod.id, db)?.config_json)

  for (const step of wizard.steps) {
    for (const f of step.fields ?? []) {
      if (f.storage === 'action' && f.targetAgentId) {
        targetAgentId = f.targetAgentId
        if (shouldEnableAgent === undefined) {
          const saved = configObj[`_action_${f.key}`]
          shouldEnableAgent =
            typeof saved === 'boolean'
              ? saved
              : typeof f.defaultValue === 'boolean'
                ? f.defaultValue
                : true
        }
      }
    }
  }

  let enabledAgentId: string | null = null
  if (targetAgentId && shouldEnableAgent !== false) {
    const packages = listAgentPackages({ ...opts, db, env })
    const pkg = packages.find((p) => p.id === targetAgentId)
    if (pkg) {
      if (!pkg.installed) {
        installAgentPackage(targetAgentId, { ...opts, db, env, enableRequiredModules: true })
        enabledAgentId = targetAgentId
      } else if (!pkg.enabled) {
        toggleAgentPackage(targetAgentId, true, { ...opts, db, env })
        enabledAgentId = targetAgentId
      } else {
        enabledAgentId = targetAgentId
      }
    }
  }

  const state = getModuleWizardState(mod.id, { ...opts, db, env })
  return {
    ok: true,
    module: enabledRes.module,
    state,
    enabledAgentId,
    restartRequired: opts?.restartRequired === true,
  }
}
