import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getAdminBatchesOverview,
  resolveBatchRuntimeEnv,
} from '../alfred/batch-runner.js'
import {
  invalidateModuleManifestCache,
  listModules,
} from '../alfred/module-manager.js'
import {
  completeModuleWizard,
  FORBIDDEN_WIZARD_ENV_KEYS,
  getModuleWizardState,
  ModuleWizardError,
  saveModuleWizardStep,
  testModuleWizardConfig,
  type WizardVaultOps,
} from '../alfred/module-wizard.js'
import { getInstalledModuleRow, initDatabase } from '../db.js'
import { tryHandleAlfredVps } from '../web/routes/alfred-vps.js'
import type { RouteContext } from '../web/routes/types.js'

function createTestDb(dbPath = ':memory:'): Database.Database {
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE IF NOT EXISTS installed_modules (
      module_id TEXT PRIMARY KEY,
      state TEXT NOT NULL CHECK(state IN ('available', 'installed_disabled', 'active')),
      installed_at TEXT,
      updated_at TEXT,
      config_json TEXT
    );
  `)
  return db
}

function createInMemoryVault(): {
  store: Map<string, { label: string; value: string }>
  ops: WizardVaultOps
  getSecretSpy: ReturnType<typeof vi.fn>
} {
  const store = new Map<string, { label: string; value: string }>()
  const getSecretSpy = vi.fn((id: string) => store.get(id)?.value ?? null)
  const ops: WizardVaultOps = {
    listSecrets: () => Array.from(store.entries()).map(([id, v]) => ({ id, label: v.label })),
    setSecret: (id: string, label: string, value: string) => {
      store.set(id, { label, value })
    },
    getSecret: getSecretSpy,
    deleteSecret: (id: string) => store.delete(id),
  }
  return { store, ops, getSecretSpy }
}

function createMockReqRes(opts: {
  method: string
  path: string
  body?: unknown
  headers?: Record<string, string>
  auth?: RouteContext['auth']
}): { ctx: RouteContext; getResult: () => { status: number; body: Record<string, unknown> } } {
  const emitter = new EventEmitter() as IncomingMessage & EventEmitter
  emitter.method = opts.method
  emitter.url = opts.path
  emitter.headers = opts.headers ?? {}

  const bodyStr = opts.body !== undefined ? JSON.stringify(opts.body) : ''
  setImmediate(() => {
    if (bodyStr) emitter.emit('data', Buffer.from(bodyStr, 'utf-8'))
    emitter.emit('end')
  })

  let statusCode = 200
  let rawBody = ''
  const res = {
    writeHead(code: number) {
      statusCode = code
      return this
    },
    end(chunk?: string | Buffer) {
      if (chunk) rawBody += chunk.toString()
      return this
    },
    setHeader() {
      return this
    },
  } as unknown as ServerResponse

  const url = new URL(`http://127.0.0.1:3420${opts.path}`)
  const ctx: RouteContext = {
    req: emitter,
    res,
    url,
    path: url.pathname,
    method: opts.method,
    auth: opts.auth,
  }

  return {
    ctx,
    getResult: () => ({
      status: statusCode,
      body: rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {},
    }),
  }
}

describe('Declarative Module Setup Wizard (01b)', () => {
  let tmpRoot: string
  let db: Database.Database

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'alfred-mod-wizard-'))
    mkdirSync(join(tmpRoot, 'modules', 'batch-api'), { recursive: true })
    mkdirSync(join(tmpRoot, 'modules', 'core-cli'), { recursive: true })
    mkdirSync(join(tmpRoot, 'config'), { recursive: true })
    mkdirSync(join(tmpRoot, 'store'), { recursive: true })

    // Copy real batch-api module.json & minimal core-cli manifest
    const realBatchManifest = readFileSync(join(process.cwd(), 'modules', 'batch-api', 'module.json'), 'utf-8')
    writeFileSync(join(tmpRoot, 'modules', 'batch-api', 'module.json'), realBatchManifest, 'utf-8')
    writeFileSync(
      join(tmpRoot, 'modules', 'core-cli', 'module.json'),
      JSON.stringify({
        id: 'core-cli',
        name: 'Core CLI',
        category: 'core',
        version: '1.0.0',
        description: 'Built-in core',
        depends: [],
        requiredSecrets: [],
        tools: [],
        uiCardIds: [],
        ramImpactMb: 0,
        builtIn: true,
        defaultEnabled: true,
      }),
      'utf-8',
    )
    writeFileSync(
      join(tmpRoot, 'config', 'agents.json'),
      JSON.stringify({ version: 1, global: {}, roles: {}, agents: [] }, null, 2),
      'utf-8',
    )

    db = createTestDb()
    invalidateModuleManifestCache()
  })

  afterEach(() => {
    try { db.close() } catch { /* ignore */ }
    invalidateModuleManifestCache()
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('masks secrets in GET state (isSet only, NEVER calls getSecret) and evaluates any_one vs all_required', () => {
    const vault = createInMemoryVault()
    const env: Record<string, string | undefined> = {}

    // Initially unconfigured: providers step (any_one) is incomplete -> needsSetup: true
    const modsBefore = listModules({ db, projectRoot: tmpRoot, env, secretIds: new Set() })
    const batchModBefore = modsBefore.find((m) => m.id === 'batch-api')!
    expect(batchModBefore.hasWizard).toBe(true)
    expect(batchModBefore.needsSetup).toBe(true)

    const stateBefore = getModuleWizardState('batch-api', {
      db,
      projectRoot: tmpRoot,
      env,
      vaultOps: vault.ops,
    })
    expect(stateBefore.configured).toBe(false)
    expect(stateBefore.needsSetup).toBe(true)
    expect(stateBefore.completedSteps).toEqual(['discord']) // discord field is required: false
    expect(stateBefore.missingRequirements.length).toBeGreaterThan(0)
    expect(vault.getSecretSpy).not.toHaveBeenCalled()

    // Store one secret in Vault -> satisfies any_one!
    vault.ops.setSecret('GEMINI_API_KEY', 'Google Gemini API kulcs', 'AIzaSuperSecretValue12345')
    const stateAfter = getModuleWizardState('batch-api', {
      db,
      projectRoot: tmpRoot,
      env,
      vaultOps: vault.ops,
    })
    expect(stateAfter.configured).toBe(true)
    expect(stateAfter.needsSetup).toBe(false)
    expect(stateAfter.completedSteps).toContain('providers')
    // NEVER called getSecret(), and raw secret never appears anywhere in serialized state
    expect(vault.getSecretSpy).not.toHaveBeenCalled()
    expect(JSON.stringify(stateAfter)).not.toContain('AIzaSuperSecretValue12345')

    const geminiField = stateAfter.steps[0].fields!.find((f) => f.key === 'GEMINI_API_KEY')!
    expect(geminiField.isSet).toBe(true)
    expect(geminiField.value).toBeUndefined()
  })

  it('rejects UNKNOWN_WIZARD_FIELD (400), forbidden system .env keys (400), and invalid DISCORD_CHANNEL regex (400)', () => {
    const vault = createInMemoryVault()
    const envFilePath = join(tmpRoot, '.env')

    // 1. Unknown field
    expect(() =>
      saveModuleWizardStep(
        'batch-api',
        { values: { RANDOM_INJECTED_KEY: 'evil' } },
        { db, projectRoot: tmpRoot, env: {}, envFilePath, vaultOps: vault.ops },
      ),
    ).toThrowError(ModuleWizardError)

    try {
      saveModuleWizardStep(
        'batch-api',
        { values: { UNKNOWN_KEY: 'x' } },
        { db, projectRoot: tmpRoot, env: {}, envFilePath, vaultOps: vault.ops },
      )
    } catch (err) {
      expect(err).toBeInstanceOf(ModuleWizardError)
      expect((err as ModuleWizardError).code).toBe('UNKNOWN_WIZARD_FIELD')
      expect((err as ModuleWizardError).statusHttp).toBe(400)
    }

    // 2. Invalid DISCORD_CHANNEL_ALFRED_BATCH regex
    try {
      saveModuleWizardStep(
        'batch-api',
        { values: { DISCORD_CHANNEL_ALFRED_BATCH: 'not-a-snowflake' } },
        { db, projectRoot: tmpRoot, env: {}, envFilePath, vaultOps: vault.ops },
      )
      expect.unreachable('Should have thrown INVALID_WIZARD_VALUE')
    } catch (err) {
      expect(err).toBeInstanceOf(ModuleWizardError)
      expect((err as ModuleWizardError).code).toBe('INVALID_WIZARD_VALUE')
      expect((err as ModuleWizardError).statusHttp).toBe(400)
    }

    // 3. Even if a malicious module.json declared a forbidden system .env key, engine blocks it!
    mkdirSync(join(tmpRoot, 'modules', 'evil-mod'), { recursive: true })
    writeFileSync(
      join(tmpRoot, 'modules', 'evil-mod', 'module.json'),
      JSON.stringify({
        id: 'evil-mod',
        name: 'Evil Mod',
        category: 'automation',
        version: '1.0.0',
        description: 'Test forbidden env guard',
        depends: [],
        requiredSecrets: [],
        tools: [],
        uiCardIds: [],
        ramImpactMb: 0,
        builtIn: false,
        defaultEnabled: false,
        setupWizard: {
          title: 'Evil',
          summary: 'Test',
          steps: [
            {
              id: 's1',
              title: 'S1',
              description: '',
              fields: [
                { key: 'NODE_OPTIONS', label: 'Node opts', type: 'text', storage: 'env' },
                { key: 'DASHBOARD_TOKEN', label: 'Token', type: 'text', storage: 'env' },
              ],
            },
          ],
        },
      }),
      'utf-8',
    )
    invalidateModuleManifestCache(tmpRoot)

    for (const forbidden of ['NODE_OPTIONS', 'DASHBOARD_TOKEN']) {
      expect(FORBIDDEN_WIZARD_ENV_KEYS.has(forbidden)).toBe(true)
      try {
        saveModuleWizardStep(
          'evil-mod',
          { values: { [forbidden]: 'pwned' } },
          { db, projectRoot: tmpRoot, env: {}, envFilePath, vaultOps: vault.ops },
        )
        expect.unreachable(`Should have blocked ${forbidden}`)
      } catch (err) {
        expect(err).toBeInstanceOf(ModuleWizardError)
        expect((err as ModuleWizardError).code).toBe('FORBIDDEN_ENV_KEY')
        expect((err as ModuleWizardError).statusHttp).toBe(400)
      }
    }
  })

  it('saves Vault (preserving on empty string, clearing on clearKeys), config_json with split-DB sync, and whitelisted .env with restartRequired', () => {
    const vault = createInMemoryVault()
    const envFilePath = join(tmpRoot, '.env')
    writeFileSync(envFilePath, 'EXISTING_KEY=keep_me\n', 'utf-8')

    // Secondary DB to verify split-brain sync
    const secondaryDbPath = join(tmpRoot, 'store', 'alfred-prod.db')
    const secondaryDb = createTestDb(secondaryDbPath)
    secondaryDb.close()

    const env: Record<string, string | undefined> = { EXISTING_KEY: 'keep_me' }

    // Step 1: Save Vault key + config_json bucket -> restartRequired: false (no .env change!)
    const res1 = saveModuleWizardStep(
      'batch-api',
      {
        stepId: 'providers',
        values: {
          GEMINI_API_KEY: 'AIzaTestKey999',
          VERTEX_EU_BATCH_BUCKET: 'gs://alfred-eu-staging',
        },
      },
      {
        db,
        projectRoot: tmpRoot,
        env,
        envFilePath,
        targetDbPaths: [secondaryDbPath],
        vaultOps: vault.ops,
      },
    )
    expect(res1.ok).toBe(true)
    expect(res1.restartRequired).toBe(false)
    expect(vault.store.get('GEMINI_API_KEY')?.value).toBe('AIzaTestKey999')

    // Verify primary AND secondary DB both received config_json
    const rowPrimary = getInstalledModuleRow('batch-api', db)
    expect(JSON.parse(rowPrimary!.config_json!).VERTEX_EU_BATCH_BUCKET).toBe('gs://alfred-eu-staging')

    const secCheck = new Database(secondaryDbPath, { readonly: true })
    const rowSecondary = getInstalledModuleRow('batch-api', secCheck)
    secCheck.close()
    expect(JSON.parse(rowSecondary!.config_json!).VERTEX_EU_BATCH_BUCKET).toBe('gs://alfred-eu-staging')

    // Empty string for secret MUST preserve existing secret!
    saveModuleWizardStep(
      'batch-api',
      { values: { GEMINI_API_KEY: '' } },
      { db, projectRoot: tmpRoot, env, envFilePath, vaultOps: vault.ops },
    )
    expect(vault.store.get('GEMINI_API_KEY')?.value).toBe('AIzaTestKey999')

    // Explicit clearKeys removes secret
    saveModuleWizardStep(
      'batch-api',
      { clearKeys: ['GEMINI_API_KEY'] },
      { db, projectRoot: tmpRoot, env, envFilePath, vaultOps: vault.ops },
    )
    expect(vault.store.has('GEMINI_API_KEY')).toBe(false)

    // Step 2: Save whitelisted .env key DISCORD_CHANNEL_ALFRED_BATCH -> restartRequired: true
    const res2 = saveModuleWizardStep(
      'batch-api',
      {
        stepId: 'discord',
        values: {
          DISCORD_CHANNEL_ALFRED_BATCH: '123456789012345678',
          enableAgentId: true,
        },
      },
      { db, projectRoot: tmpRoot, env, envFilePath, vaultOps: vault.ops },
    )
    expect(res2.restartRequired).toBe(true)
    const envDisk = readFileSync(envFilePath, 'utf-8')
    expect(envDisk).toContain('EXISTING_KEY=keep_me')
    expect(envDisk).toContain('DISCORD_CHANNEL_ALFRED_BATCH=123456789012345678')
  })

  it('resolves batch-runner credentials with Vault -> env and config_json -> env precedence', () => {
    const vault = createInMemoryVault()
    vault.ops.setSecret('ANTHROPIC_API_KEY', 'Anthropic', 'sk-ant-from-vault')

    db.prepare(
      `INSERT INTO installed_modules (module_id, state, installed_at, updated_at, config_json)
       VALUES ('batch-api', 'active', '2026-01-01', '2026-01-01', ?)`,
    ).run(JSON.stringify({ VERTEX_EU_BATCH_BUCKET: 'gs://bucket-from-config-json' }))

    const env = {
      ANTHROPIC_API_KEY: 'sk-ant-from-env-fallback',
      OPENAI_API_KEY: 'sk-oai-only-in-env',
      VERTEX_EU_BATCH_BUCKET: 'gs://bucket-from-env',
      VERTEX_EU_ACCESS_TOKEN: 'v-tok',
      VERTEX_EU_PROJECT_ID: 'proj-eu-1',
    }

    // Decrypted mode (submit/poll): Vault wins over env, config_json wins over env
    const resolved = resolveBatchRuntimeEnv(env, { db, decryptSecrets: true, vaultOps: vault.ops })
    expect(resolved['ANTHROPIC_API_KEY']).toBe('sk-ant-from-vault')
    expect(resolved['OPENAI_API_KEY']).toBe('sk-oai-only-in-env')
    expect(resolved['VERTEX_EU_BATCH_BUCKET']).toBe('gs://bucket-from-config-json')

    // Decryption-free overview mode: detects Vault secret via listSecrets() without decrypting!
    vault.getSecretSpy.mockClear()
    const overview = getAdminBatchesOverview(
      db,
      { VERTEX_EU_ACCESS_TOKEN: 'v-tok', VERTEX_EU_PROJECT_ID: 'proj-eu-1' },
      { vaultOps: vault.ops },
    )
    expect(vault.getSecretSpy).not.toHaveBeenCalled()
    expect(overview.byProvider.find((p) => p.provider === 'anthropic')?.configured).toBe(true)
    expect(overview.byProvider.find((p) => p.provider === 'vertex-eu')?.configured).toBe(true)
    expect(overview.byProvider.find((p) => p.provider === 'gemini')?.configured).toBe(false)
  })

  it('executes batch_provider_probe (0-token probe) and completeModuleWizard', async () => {
    const vault = createInMemoryVault()

    // No provider configured -> fails cleanly
    const failProbe = await testModuleWizardConfig('batch-api', {
      db,
      projectRoot: tmpRoot,
      env: {},
      vaultOps: vault.ops,
    })
    expect(failProbe.ok).toBe(false)
    expect(failProbe.checks[0].ok).toBe(false)

    // Configure Gemini in Vault and run mocked 0-token probe
    vault.ops.setSecret('GEMINI_API_KEY', 'Gemini', 'AIzaLiveProbeKey')
    const mockFetch: typeof fetch = vi.fn(async (input) => {
      if (String(input).includes('generativelanguage.googleapis.com/v1beta/models')) {
        return new Response(JSON.stringify({ models: [] }), { status: 200 })
      }
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch

    const okProbe = await testModuleWizardConfig('batch-api', {
      db,
      projectRoot: tmpRoot,
      env: {},
      vaultOps: vault.ops,
      fetchImpl: mockFetch,
    })
    expect(okProbe.ok).toBe(true)
    expect(okProbe.testAction).toBe('batch_provider_probe')
    expect(okProbe.checks.some((c) => c.label.includes('Gemini') && c.ok)).toBe(true)

    // Complete wizard activates module
    const completed = completeModuleWizard('batch-api', {
      db,
      projectRoot: tmpRoot,
      env: {},
      vaultOps: vault.ops,
      enableAgent: false,
      restartRequired: true,
    })
    expect(completed.ok).toBe(true)
    expect(completed.module.state).toBe('active')
    expect(completed.restartRequired).toBe(true)
  })

  it('enforces 401/403/200 auth and schema errors across all 4 Admin Wizard REST API routes', async () => {
    initDatabase(':memory:')
    const prevToken = process.env['DASHBOARD_TOKEN']
    const prevEnv = process.env['ALFRED_ENV']
    process.env['DASHBOARD_TOKEN'] = 'wizard-test-secret-token'
    process.env['ALFRED_ENV'] = 'test'

    try {
      // 1. 401 Unauthorized when no auth/token provided
      const r401 = createMockReqRes({ method: 'GET', path: '/api/admin/modules/batch-api/wizard' })
      expect(await tryHandleAlfredVps(r401.ctx)).toBe(true)
      expect(r401.getResult().status).toBe(401)

      // 2. 403 Forbidden when non-owner agent token is used
      const r403 = createMockReqRes({
        method: 'POST',
        path: '/api/admin/modules/batch-api/wizard/save',
        body: { values: {} },
        auth: { kind: 'token', user: 'sub-agent', tokenAgent: 'alfred-qa' },
      })
      expect(await tryHandleAlfredVps(r403.ctx)).toBe(true)
      expect(r403.getResult().status).toBe(403)

      // 3. 200 OK with valid DASHBOARD_TOKEN on GET /wizard
      const rGet = createMockReqRes({
        method: 'GET',
        path: '/api/admin/modules/batch-api/wizard',
        headers: { authorization: 'Bearer wizard-test-secret-token' },
      })
      expect(await tryHandleAlfredVps(rGet.ctx)).toBe(true)
      const getRes = rGet.getResult()
      expect(getRes.status).toBe(200)
      expect(getRes.body.ok).toBe(true)
      expect((getRes.body.state as { moduleId: string }).moduleId).toBe('batch-api')

      // 4. 400 UNKNOWN_WIZARD_FIELD on POST /wizard/save
      const rBadField = createMockReqRes({
        method: 'POST',
        path: '/api/admin/modules/batch-api/wizard/save',
        headers: { authorization: 'Bearer wizard-test-secret-token' },
        body: { values: { HACKED_ENV: '1' } },
      })
      expect(await tryHandleAlfredVps(rBadField.ctx)).toBe(true)
      expect(rBadField.getResult().status).toBe(400)
      expect(rBadField.getResult().body.code).toBe('UNKNOWN_WIZARD_FIELD')

      // 5. 200 OK on POST /wizard/test
      const rTest = createMockReqRes({
        method: 'POST',
        path: '/api/admin/modules/batch-api/wizard/test',
        headers: { authorization: 'Bearer wizard-test-secret-token' },
      })
      expect(await tryHandleAlfredVps(rTest.ctx)).toBe(true)
      expect(rTest.getResult().status).toBe(200)
      expect(Array.isArray(rTest.getResult().body.checks)).toBe(true)

      // 6. 200 OK on POST /wizard/complete
      const rComplete = createMockReqRes({
        method: 'POST',
        path: '/api/admin/modules/batch-api/wizard/complete',
        headers: { authorization: 'Bearer wizard-test-secret-token' },
        body: { enableAgent: false, restartRequired: false },
      })
      expect(await tryHandleAlfredVps(rComplete.ctx)).toBe(true)
      const compRes = rComplete.getResult()
      expect(compRes.status).toBe(200)
      expect(compRes.body.ok).toBe(true)
      expect(Array.isArray(compRes.body.modules)).toBe(true)
      expect(Array.isArray(compRes.body.agentPackages)).toBe(true)
    } finally {
      if (prevToken === undefined) delete process.env['DASHBOARD_TOKEN']
      else process.env['DASHBOARD_TOKEN'] = prevToken
      if (prevEnv === undefined) delete process.env['ALFRED_ENV']
      else process.env['ALFRED_ENV'] = prevEnv
    }
  })
})
