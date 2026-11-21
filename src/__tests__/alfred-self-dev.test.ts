import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import {
  clearVertexTokenCache,
  executeWhitelistedTool,
  getAgentByChannelId,
  loadAlfredAgentsConfig,
  mapWhitelistToClaudePermissions,
  matchProtectedPath,
  ProtectedPathError,
  validateBashCommand,
  validateGitArgs,
  WorkspaceBoundaryError,
  type AgentConfig,
} from '../alfred/index.js'

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

describe('Alfred Self-Dev (#alfred-self-dev & alfred-self-coder)', () => {
  let tempDir: string

  beforeEach(() => {
    clearVertexTokenCache()
    tempDir = mkdtempSync(join(tmpdir(), 'alfred-self-dev-test-'))
    initDatabase(':memory:')
  })

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore Windows handle lock cleanup errors
    }
  })

  function makeTempSelfDevAgent(workspaceAbsPath: string): AgentConfig {
    const cfg = loadAlfredAgentsConfig({
      env: { DISCORD_CHANNEL_ALFRED_SELF_DEV: '4444444444444444444' },
      provisionWorkspaces: false,
    })
    const base = cfg.agents.find((a) => a.id === 'alfred-self-coder')!
    return {
      ...base,
      workspaceAbsPath,
    }
  }

  it('loads alfred-self-coder config, SOUL.md, protectedPaths, and channel routing', () => {
    const cfg = loadAlfredAgentsConfig({
      env: {
        DISCORD_CHANNEL_ALFRED_HQ: '1111111111111111111',
        DISCORD_CHANNEL_PROJ_HYPATIA: '2222222222222222222',
        DISCORD_CHANNEL_ALFRED_QA: '3333333333333333333',
        DISCORD_CHANNEL_ALFRED_SELF_DEV: '4444444444444444444',
        DISCORD_CHANNEL_ALFRED_OPS: '5555555555555555555',
      },
      provisionWorkspaces: false,
    })

    const selfCoder: AgentConfig = cfg.agents.find((a) => a.id === 'alfred-self-coder')!
    expect(selfCoder).toBeDefined()
    expect(selfCoder.displayName).toBe('Alfred Self-Coder')
    expect(selfCoder.channelName).toBe('#alfred-self-dev')
    expect(selfCoder.discordChannelId).toBe('4444444444444444444')
    expect(selfCoder.provider).toBe('deepseek')
    expect(selfCoder.model).toBe('deepseek-reasoner')
    expect(selfCoder.workspace).toBe('.')
    expect(selfCoder.workspaceAbsPath).toBe(resolve(process.cwd()))
    expect(selfCoder.memoryNamespace).toBe('alfred-self-coder')
    expect(selfCoder.dailyBudgetUsd).toBe(5.0)
    expect(selfCoder.maxToolIterations).toBe(12)
    expect(selfCoder.tools).toEqual(['bash', 'fs_read', 'fs_write', 'git', 'memory'])
    expect(selfCoder.protectedPaths).toEqual(
      expect.arrayContaining([
        'src/alfred/circuit-breaker.ts',
        'src/alfred/tool-executor.ts',
        'src/alfred/agents-config.ts',
        'config/agents.json',
        '.env',
        '.env.example',
        'store/',
        'deploy/',
        'vitest.config.ts',
        'vitest.alfred.config.ts',
        'tsconfig.alfred.json',
        'tsconfig.alfred.build.json',
        'package.json',
      ]),
    )
    expect(selfCoder.soulFile).toBe('agents/alfred-self-coder/SOUL.md')
    expect(selfCoder.resolvedSystemPrompt).toContain('Alfred Self-Coder')
    expect(selfCoder.resolvedSystemPrompt).toContain('feat/self-*')
    expect(selfCoder.resolvedSystemPrompt).toContain('protectedPaths')

    expect(getAgentByChannelId(cfg, '4444444444444444444')?.id).toBe('alfred-self-coder')
  })

  it('fails closed if workspace "." has mutating tools without non-empty protectedPaths', () => {
    const customConfigPath = join(tempDir, 'bad-agents.json')
    writeFileSync(
      customConfigPath,
      JSON.stringify({
        version: 1,
        global: { defaultProvider: 'deepseek', defaultModel: 'deepseek-chat', dailyBudgetUsd: 10, workspacesRoot: 'workspaces' },
        agents: [
          {
            id: 'unsafe-self-coder',
            workspace: '.',
            tools: ['fs_write'],
            protectedPaths: [],
          },
        ],
      }),
      'utf-8',
    )

    expect(() =>
      loadAlfredAgentsConfig({
        configPath: customConfigPath,
        projectRoot: tempDir,
        provisionWorkspaces: false,
      }),
    ).toThrow(/Security violation.*protectedPaths/i)
  })

  it('blocks fs_write on all protectedPaths (including traversal normalization and symlinks)', () => {
    const db = getDb()
    const ws = join(tempDir, 'repo')
    mkdirSync(join(ws, 'src', 'alfred'), { recursive: true })
    mkdirSync(join(ws, 'config'), { recursive: true })
    mkdirSync(join(ws, 'store'), { recursive: true })
    mkdirSync(join(ws, 'deploy'), { recursive: true })
    writeFileSync(join(ws, 'src', 'alfred', 'circuit-breaker.ts'), '// protected\n', 'utf-8')
    writeFileSync(join(ws, '.env'), 'SECRET=1\n', 'utf-8')

    const agent = makeTempSelfDevAgent(ws)

    const blockedTargets = [
      'src/alfred/circuit-breaker.ts',
      './src/alfred/circuit-breaker.ts',
      'src\\alfred\\circuit-breaker.ts',
      'src/alfred/tool-executor.ts',
      'src/alfred/agents-config.ts',
      'config/agents.json',
      '.env',
      '.env.example',
      'store/alfred.db',
      'store/nested/state.json',
      'deploy/spinup-test.sh',
      'vitest.alfred.config.ts',
      'package.json',
    ]

    for (const target of blockedTargets) {
      expect(() =>
        executeWhitelistedTool({ agent, db }, 'fs_write', { path: target, content: 'hacked' }),
      ).toThrow(ProtectedPathError)
    }

    // Verify symlink pointing to a protected file cannot bypass fs_write protection
    const symlinkPath = join(ws, 'src', 'alfred', 'alias-cb.ts')
    let symlinkCreated = false
    try {
      symlinkSync(join(ws, 'src', 'alfred', 'circuit-breaker.ts'), symlinkPath)
      symlinkCreated = true
    } catch {
      // Windows without Developer Mode may forbid creating symlinks with EPERM
    }
    if (symlinkCreated) {
      expect(() =>
        executeWhitelistedTool({ agent, db }, 'fs_write', {
          path: 'src/alfred/alias-cb.ts',
          content: 'bypassed',
        }),
      ).toThrow(ProtectedPathError)
    }
    expect(matchProtectedPath(ws, join(ws, 'src', 'alfred', 'circuit-breaker.ts'), agent.protectedPaths)).toBe(
      'src/alfred/circuit-breaker.ts',
    )
  })

  it('allows fs_read on source/config files while blocking .env and store/', () => {
    const db = getDb()
    const ws = join(tempDir, 'repo')
    mkdirSync(join(ws, 'src', 'alfred'), { recursive: true })
    mkdirSync(join(ws, 'config'), { recursive: true })
    mkdirSync(join(ws, 'store'), { recursive: true })

    writeFileSync(join(ws, 'src', 'alfred', 'circuit-breaker.ts'), 'export const CB = 1\n', 'utf-8')
    writeFileSync(join(ws, 'config', 'agents.json'), '{"version":1}\n', 'utf-8')
    writeFileSync(join(ws, '.env.example'), 'DEEPSEEK_API_KEY=\n', 'utf-8')
    writeFileSync(join(ws, '.env'), 'DEEPSEEK_API_KEY=sk-real-secret\n', 'utf-8')
    writeFileSync(join(ws, '.env.test'), 'DISCORD_BOT_TOKEN=secret\n', 'utf-8')
    writeFileSync(join(ws, 'store', 'alfred.db'), 'sqlite-bytes', 'utf-8')

    const agent = makeTempSelfDevAgent(ws)

    expect(executeWhitelistedTool({ agent, db }, 'fs_read', { path: '.' })).toContain('src/')
    expect(executeWhitelistedTool({ agent, db }, 'fs_read', { path: 'src/alfred/circuit-breaker.ts' })).toBe(
      'export const CB = 1\n',
    )
    expect(executeWhitelistedTool({ agent, db }, 'fs_read', { path: 'config/agents.json' })).toBe(
      '{"version":1}\n',
    )
    expect(executeWhitelistedTool({ agent, db }, 'fs_read', { path: '.env.example' })).toBe(
      'DEEPSEEK_API_KEY=\n',
    )

    for (const secretPath of ['.env', './.env', '.env.test', 'store', 'store/', 'store/alfred.db']) {
      expect(() => executeWhitelistedTool({ agent, db }, 'fs_read', { path: secretPath })).toThrow(
        ProtectedPathError,
      )
    }
  })

  it('blocks protected path writes, secret reads, and destructive git commands via bash', () => {
    const db = getDb()
    const ws = join(tempDir, 'repo')
    mkdirSync(join(ws, 'src', 'alfred'), { recursive: true })
    const agent = makeTempSelfDevAgent(ws)

    expect(() =>
      executeWhitelistedTool({ agent, db }, 'bash', { command: 'echo hacked > src/alfred/circuit-breaker.ts' }),
    ).toThrow(ProtectedPathError)
    expect(() =>
      executeWhitelistedTool({ agent, db }, 'bash', { command: 'sed -i "s/a/b/" config/agents.json' }),
    ).toThrow(ProtectedPathError)
    expect(() =>
      executeWhitelistedTool({ agent, db }, 'bash', { command: 'rm -f deploy/spinup-test.sh' }),
    ).toThrow(ProtectedPathError)
    expect(() =>
      executeWhitelistedTool({ agent, db }, 'bash', { command: 'Set-Content .env.example "FOO=bar"' }),
    ).toThrow(ProtectedPathError)
    expect(() =>
      executeWhitelistedTool({ agent, db }, 'bash', { command: 'node -e "require(\'fs\').writeFileSync(\'src/alfred/tool-executor.ts\', \'x\')"' }),
    ).toThrow(ProtectedPathError)
    expect(() =>
      executeWhitelistedTool({ agent, db }, 'bash', { command: 'cat .env' }),
    ).toThrow(ProtectedPathError)
    expect(() =>
      executeWhitelistedTool({ agent, db }, 'bash', { command: 'sqlite3 store/alfred.db ".tables"' }),
    ).toThrow(ProtectedPathError)
    expect(() =>
      executeWhitelistedTool({ agent, db }, 'bash', { command: 'git push --force origin feat/self-x' }),
    ).toThrow(/BASH_POLICY_VIOLATION/)
    expect(() =>
      executeWhitelistedTool({ agent, db }, 'bash', { command: 'git reset --hard HEAD~1' }),
    ).toThrow(/BASH_POLICY_VIOLATION/)

    // Should NOT falsely block read-only commands on .env.example or unrelated store/ paths
    expect(() => validateBashCommand('cat .env.example', agent, 'feat/self-ok')).not.toThrow()
    expect(() => validateBashCommand('cat src/store/item.ts', agent, 'feat/self-ok')).not.toThrow()

    const out = executeWhitelistedTool({ agent, db }, 'bash', {
      command: 'node -e "console.log(\'self-dev-bash-ok\')"',
    })
    expect(out).toBe('self-dev-bash-ok')
  })

  it('enforces Git self-defense rules and executes a full self-dev workflow in an isolated temp repo', () => {
    const db = getDb()
    const repo = join(tempDir, 'git-repo')
    mkdirSync(join(repo, 'src', 'alfred'), { recursive: true })
    mkdirSync(join(repo, 'config'), { recursive: true })
    writeFileSync(join(repo, 'src', 'alfred', 'circuit-breaker.ts'), 'export const CB = 1\n', 'utf-8')
    writeFileSync(join(repo, 'config', 'agents.json'), '{"version":1}\n', 'utf-8')

    runGit(repo, ['init'])
    runGit(repo, ['checkout', '-B', 'main'])
    runGit(repo, ['config', 'user.name', 'Alfred Self Test'])
    runGit(repo, ['config', 'user.email', 'alfred-test@example.local'])
    runGit(repo, ['add', '.'])
    runGit(repo, ['commit', '-m', 'init'])
    runGit(repo, ['checkout', '-b', 'feat/alfred-core'])

    const agent = makeTempSelfDevAgent(repo)

    // 1. Direct commit on feat/alfred-core is forbidden
    expect(() =>
      executeWhitelistedTool({ agent, db }, 'git', { args: ['commit', '--allow-empty', '-m', 'nope'] }),
    ).toThrow(/GIT_POLICY_VIOLATION/)

    // 2. Switching to main/master or creating non-self-dev branches is forbidden
    expect(() =>
      executeWhitelistedTool({ agent, db }, 'git', { args: ['checkout', 'main'] }),
    ).toThrow(/GIT_POLICY_VIOLATION/)
    expect(() =>
      executeWhitelistedTool({ agent, db }, 'git', { args: ['checkout', '-b', 'random-branch'] }),
    ).toThrow(/GIT_POLICY_VIOLATION/)

    // 3. Force push, reset --hard, and global-flag prefix bypasses are forbidden
    expect(() =>
      executeWhitelistedTool({ agent, db }, 'git', { args: ['--no-pager', 'reset', '--hard'] }),
    ).toThrow(/GIT_POLICY_VIOLATION/)
    expect(() =>
      executeWhitelistedTool({ agent, db }, 'git', { args: ['push', '--force', 'origin', 'feat/self-x'] }),
    ).toThrow(/GIT_POLICY_VIOLATION/)
    expect(() =>
      executeWhitelistedTool({ agent, db }, 'git', { args: ['push', 'origin', '+feat/self-x:feat/self-x'] }),
    ).toThrow(/GIT_POLICY_VIOLATION/)
    expect(() =>
      executeWhitelistedTool({ agent, db }, 'git', { args: ['push', 'origin', 'HEAD:feat/alfred-core'] }),
    ).toThrow(/GIT_POLICY_VIOLATION/)
    expect(() =>
      validateGitArgs(['-C/tmp', 'status'], { requireSelfDevBranch: true }),
    ).toThrow(WorkspaceBoundaryError)

    // 4. Restoring/overwriting protected files via git checkout/restore is blocked
    expect(() =>
      executeWhitelistedTool({ agent, db }, 'git', { args: ['checkout', '--', 'src/alfred/circuit-breaker.ts'] }),
    ).toThrow(ProtectedPathError)
    expect(() =>
      executeWhitelistedTool({ agent, db }, 'git', { args: ['restore', 'config/agents.json'] }),
    ).toThrow(ProtectedPathError)

    // 5. Positive self-dev flow: branch off feat/alfred-core onto feat/self-dummy-tool, write & test & commit!
    executeWhitelistedTool({ agent, db }, 'git', {
      args: ['checkout', '-b', 'feat/self-dummy-tool', 'feat/alfred-core'],
    })
    expect(runGit(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('feat/self-dummy-tool')

    const writeToolRes = executeWhitelistedTool({ agent, db }, 'fs_write', {
      path: 'src/alfred/tools/dummy.ts',
      content: 'export function pingSelfDev(): string { return "pong"; }\n',
    })
    expect(writeToolRes).toContain('OK:')

    const writeSoulRes = executeWhitelistedTool({ agent, db }, 'fs_write', {
      path: 'agents/uj-projekt/SOUL.md',
      content: '# Uj Projekt -- Alfred Sablon\n',
    })
    expect(writeSoulRes).toContain('OK:')

    expect(executeWhitelistedTool({ agent, db }, 'fs_read', { path: 'src/alfred/tools/dummy.ts' })).toContain(
      'pingSelfDev',
    )

    const bashTestOut = executeWhitelistedTool({ agent, db }, 'bash', {
      command: 'node -e "const fs = require(\'fs\'); if (!fs.existsSync(\'src/alfred/tools/dummy.ts\')) process.exit(1); console.log(\'GREEN\')"',
    })
    expect(bashTestOut).toBe('GREEN')

    executeWhitelistedTool({ agent, db }, 'git', { args: ['add', 'src/alfred/tools/dummy.ts', 'agents/uj-projekt/SOUL.md'] })
    executeWhitelistedTool({ agent, db }, 'git', { args: ['commit', '-m', 'feat(self): add dummy tool and template'] })

    expect(runGit(repo, ['log', '-1', '--pretty=%s'])).toBe('feat(self): add dummy tool and template')
    expect(existsSync(join(repo, 'src', 'alfred', 'tools', 'dummy.ts'))).toBe(true)

    const claudePerms = mapWhitelistToClaudePermissions(agent.tools, repo, {
      protectedPaths: agent.protectedPaths,
      protectedBranches: ['feat/alfred-core'],
    })
    expect(claudePerms.deny).toContain('Bash(git checkout feat/alfred-core*)')
    expect(claudePerms.deny.some((d) => d.includes('circuit-breaker.ts'))).toBe(true)
  })
})
