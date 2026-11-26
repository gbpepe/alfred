import { execFileSync, execSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type Database from 'better-sqlite3'
import { MAIN_AGENT_ID } from '../config.js'
import type { AlfredAgentDefinition, AllowedToolName } from './agents-config.js'
import { getCliInventory, installOrUpdateCli, removeCli } from './cli-manager.js'
import type { CliProcessRunner } from './cli-runner.js'
import {
  cancelBatchJob,
  getBatchJobById,
  listBatchJobs,
  pollBatchJob,
  resolveBatchConfinedPath,
  submitBatchJob,
  type BatchTaskType,
  type RequestedBatchProvider,
} from './batch-runner.js'
import { runHousekeeping } from './housekeeper.js'
import {
  disableModule,
  enableModule,
  installAgentPackage,
  listAgentPackages,
  listModules,
  resolveToolOwnerModule,
  toggleAgentPackage,
} from './module-manager.js'
import { collectSystemTelemetry } from './system-monitor.js'

export interface OpenAiToolSchema {
  type: 'function'
  function: {
    name: AllowedToolName
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    }
  }
}

export const TOOL_SCHEMAS: Record<AllowedToolName, OpenAiToolSchema> = {
  fs_read: {
    type: 'function',
    function: {
      name: 'fs_read',
      description: 'Read a file or list a directory inside the agent isolated workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path inside the agent workspace (e.g. "src/index.ts" or ".").',
          },
        },
        required: ['path'],
      },
    },
  },
  fs_write: {
    type: 'function',
    function: {
      name: 'fs_write',
      description: 'Create or overwrite a file inside the agent isolated workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path inside the agent workspace.',
          },
          content: {
            type: 'string',
            description: 'Full text content to write to the file.',
          },
        },
        required: ['path', 'content'],
      },
    },
  },
  bash: {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Execute a shell command inside the agent isolated workspace.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Shell command to execute.',
          },
        },
        required: ['command'],
      },
    },
  },
  git: {
    type: 'function',
    function: {
      name: 'git',
      description: 'Run a git command inside the agent workspace. Switching or pushing to main/master is forbidden.',
      parameters: {
        type: 'object',
        properties: {
          args: {
            type: 'array',
            items: { type: 'string' },
            description: 'Git CLI arguments (e.g. ["status", "--short"] or ["diff"]).',
          },
        },
        required: ['args'],
      },
    },
  },
  memory: {
    type: 'function',
    function: {
      name: 'memory',
      description: 'Read, search, or save memories in the agent isolated SQLite memory namespace.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['read', 'search', 'save'],
            description: 'Memory operation: read recent, search by query, or save a new memory.',
          },
          content: {
            type: 'string',
            description: 'Memory text to save (for action="save") or search query (for action="search").',
          },
          category: {
            type: 'string',
            enum: ['hot', 'warm', 'cold'],
            description: 'Memory tier (default: "warm"). Never "shared" to preserve strict namespace isolation.',
          },
        },
        required: ['action'],
      },
    },
  },
  cli_manage: {
    type: 'function',
    function: {
      name: 'cli_manage',
      description: 'Inspect, install, update, or remove user-level headless CLIs (claude, codex, gemini). Restricted to alfred-ops.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'install', 'update', 'remove'],
            description: 'CLI lifecycle operation: status, install, update, or remove.',
          },
          provider: {
            type: 'string',
            enum: ['claude', 'codex', 'gemini'],
            description: 'Target CLI provider (required for install, update, and remove).',
          },
          purgeAuth: {
            type: 'boolean',
            description: 'Only for action="remove": also delete local auth/config directory (default: false).',
          },
        },
        required: ['action'],
      },
    },
  },
  system_storage: {
    type: 'function',
    function: {
      name: 'system_storage',
      description: 'Query real-time RAM, Swap, Node RSS, SSD partition saturation, and directory storage breakdown, or trigger immediate SSD housekeeping and SQLite WAL checkpoint. Restricted to alfred-ops.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'cleanup'],
            description: 'Storage operation: status (RAM/SSD telemetry & directory breakdown) or cleanup (immediate housekeeping + SQLite WAL checkpoint).',
          },
        },
        required: ['action'],
      },
    },
  },
  module_manage: {
    type: 'function',
    function: {
      name: 'module_manage',
      description: 'List, install, enable, or disable Alfred system modules and specialist agent packages. Restricted to main agent and alfred-ops.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'list',
              'install_module',
              'enable_module',
              'disable_module',
              'install_agent',
              'enable_agent',
              'disable_agent',
            ],
            description: 'Module or agent package lifecycle operation.',
          },
          target_id: {
            type: 'string',
            description: 'Target module ID or specialist agent package ID (required for all actions except list).',
          },
          with_dependencies: {
            type: 'boolean',
            description: 'When enabling a module, recursively enable required dependency modules (default: true).',
          },
          disable_dependent_agents: {
            type: 'boolean',
            description: 'When disabling a module, also disable active specialist agents that require it (default: false).',
          },
        },
        required: ['action'],
      },
    },
  },
  batch_submit: {
    type: 'function',
    function: {
      name: 'batch_submit',
      description: 'Submit a canonical JSONL file (under batch/ or store/batch/) to the Multi-Provider Async Batch API (50% API discount). Supports auto provider selection, GDPR eu_only routing, secret-gate scanning, and pre-flight budget checks.',
      parameters: {
        type: 'object',
        properties: {
          input_path: {
            type: 'string',
            description: 'Relative path to canonical JSONL input file inside batch/ or store/batch/.',
          },
          provider: {
            type: 'string',
            enum: ['auto', 'anthropic', 'gemini', 'vertex-eu', 'openai'],
            description: 'Target Batch provider (default: "auto").',
          },
          model: {
            type: 'string',
            description: 'Optional model override for the chosen provider.',
          },
          task_type: {
            type: 'string',
            enum: ['code', 'reasoning', 'translation', 'extraction', 'general'],
            description: 'Optional task type hint for auto routing.',
          },
          eu_only: {
            type: 'boolean',
            description: 'When true, strictly routes to vertex-eu (europe-central2) with no non-EU fallback.',
          },
        },
        required: ['input_path'],
      },
    },
  },
  batch_status: {
    type: 'function',
    function: {
      name: 'batch_status',
      description: 'Inspect the status, progress, and cost/savings of a batch job. Set poll=true to query the upstream provider now.',
      parameters: {
        type: 'object',
        properties: {
          batch_id: {
            type: 'string',
            description: 'Local batch job ID (e.g. "batch_1700000000_abcd1234").',
          },
          poll: {
            type: 'boolean',
            description: 'Whether to poll the upstream provider immediately (default: false).',
          },
        },
        required: ['batch_id'],
      },
    },
  },
  batch_list: {
    type: 'function',
    function: {
      name: 'batch_list',
      description: 'List recent asynchronous batch jobs, optionally filtered by status.',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['queued', 'submitted', 'running', 'downloading', 'completed', 'failed', 'cancelled'],
            description: 'Optional status filter.',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of jobs to return (default: 20, max: 100).',
          },
        },
      },
    },
  },
  batch_cancel: {
    type: 'function',
    function: {
      name: 'batch_cancel',
      description: 'Cancel an active asynchronous batch job at the upstream provider and mark it cancelled locally.',
      parameters: {
        type: 'object',
        properties: {
          batch_id: {
            type: 'string',
            description: 'Local batch job ID to cancel.',
          },
        },
        required: ['batch_id'],
      },
    },
  },
}

function isModuleManageAuthorized(agentId: string | undefined): boolean {
  if (!agentId) return false
  return agentId === MAIN_AGENT_ID || agentId === 'alfred' || agentId === 'alfred-core' || agentId === 'alfred-ops'
}

function buildModuleDisabledResponse(toolName: string, moduleId: string): string {
  return JSON.stringify(
    {
      ok: false,
      code: 'MODULE_DISABLED_ERROR',
      tool: toolName,
      moduleId,
      message: `A(z) "${moduleId}" modul jelenleg ki van kapcsolva, ezért a(z) "${toolName}" eszköz nem hívható. Kapcsold be a Dashboard #modules felületén vagy a module_manage eszközzel.`,
    },
    null,
    2,
  )
}

/**
 * Layer 1 of Tool Whitelist enforcement:
 * Returns ONLY the OpenAI/Gemini function schemas for the tools explicitly listed
 * in `agent.tools` whose owning system module is currently `active`.
 * For zero-tool agents (`tools: []`), returns `[]`.
 */
export function getWhitelistedToolSchemas(
  agent: Pick<AlfredAgentDefinition, 'tools'> & { id?: string },
  opts?: { db?: Database.Database; projectRoot?: string },
): OpenAiToolSchema[] {
  return agent.tools
    .filter((t): t is AllowedToolName => {
      if (!Object.prototype.hasOwnProperty.call(TOOL_SCHEMAS, t)) return false
      if (t === 'module_manage' && agent.id && !isModuleManageAuthorized(agent.id)) return false
      const owner = resolveToolOwnerModule(t, { db: opts?.db, projectRoot: opts?.projectRoot })
      if (owner && !owner.active) return false
      return true
    })
    .map((t) => TOOL_SCHEMAS[t])
}

export interface ClaudePermissionsOptions {
  protectedPaths?: readonly string[]
  protectedBranches?: readonly string[]
  allowedBashCommands?: readonly string[]
}

/**
 * Maps an Alfred tool whitelist to Claude Code `permissions.allow` and `permissions.deny` rules
 * so CLI-spawned sessions enforce the exact same boundaries.
 */
export function mapWhitelistToClaudePermissions(
  tools: readonly AllowedToolName[],
  workspaceAbsPath: string,
  opts: ClaudePermissionsOptions = {},
): { allow: string[]; deny: string[] } {
  const allowSet = new Set<AllowedToolName>(tools)
  const allow: string[] = []
  const deny: string[] = [
    'Bash(git checkout main*)',
    'Bash(git checkout master*)',
    'Bash(git switch main*)',
    'Bash(git switch master*)',
    'Bash(git push*main*)',
    'Bash(git push*master*)',
    'Bash(git push*--force*)',
    'Bash(git push*-f*)',
    'Bash(git reset --hard*)',
  ]

  for (const branch of opts.protectedBranches ?? []) {
    const clean = branch.trim()
    if (!clean) continue
    deny.push(
      `Bash(git checkout ${clean}*)`,
      `Bash(git switch ${clean}*)`,
      `Bash(git push*${clean}*)`,
    )
  }

  const normWs = workspaceAbsPath.replace(/\\/g, '/').replace(/\/+$/, '')
  const absPrefix = normWs.startsWith('/') ? `/${normWs}` : `//${normWs}`

  if (allowSet.has('fs_read')) {
    allow.push(`Read(${absPrefix}/**)`)
    deny.push(`Read(${absPrefix}/.env)`, `Read(${absPrefix}/store/**)`)
  } else {
    deny.push('Read')
  }

  if (allowSet.has('fs_write')) {
    allow.push(`Edit(${absPrefix}/**)`, `Write(${absPrefix}/**)`)
    for (const rule of opts.protectedPaths ?? []) {
      const cleanRule = rule.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/^\/+/, '').replace(/\/+$/, '')
      if (!cleanRule) continue
      const suffix = rule.endsWith('/') ? `${cleanRule}/**` : cleanRule
      deny.push(`Edit(${absPrefix}/${suffix})`, `Write(${absPrefix}/${suffix})`)
    }
  } else {
    deny.push('Edit', 'Write', 'MultiEdit', 'NotebookEdit')
  }

  if (allowSet.has('bash')) {
    if (opts.allowedBashCommands !== undefined) {
      for (const cmd of opts.allowedBashCommands) {
        allow.push(`Bash(${cmd.replace('<self-branch>', '*')})`)
      }
    } else {
      allow.push('Bash(*)')
    }
  } else if (allowSet.has('git')) {
    allow.push('Bash(git:*)')
  } else {
    deny.push('Bash')
  }

  return { allow, deny }
}

export class ToolNotAllowedError extends Error {
  public readonly code = 'TOOL_NOT_ALLOWED' as const
  public readonly toolName: string
  public readonly agentId: string

  constructor(agentId: string, toolName: string, allowed: readonly string[]) {
    super(
      `TOOL_NOT_ALLOWED: Agent "${agentId}" is not allowed to call tool "${toolName}". ` +
      `Whitelisted tools: [${allowed.join(', ')}]`,
    )
    this.name = 'ToolNotAllowedError'
    this.toolName = toolName
    this.agentId = agentId
  }
}

export class WorkspaceBoundaryError extends Error {
  public readonly code = 'WORKSPACE_BOUNDARY_VIOLATION' as const
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceBoundaryError'
  }
}

export class ProtectedPathError extends Error {
  public readonly code = 'PROTECTED_PATH_VIOLATION' as const
  public readonly agentId: string
  public readonly targetPath: string
  public readonly matchedRule: string
  public readonly operation: 'fs_read' | 'fs_write' | 'bash' | 'git'

  constructor(
    agentId: string,
    targetPath: string,
    matchedRule: string,
    operation: 'fs_read' | 'fs_write' | 'bash' | 'git',
    detail?: string,
  ) {
    super(
      `PROTECTED_PATH_VIOLATION: Agent "${agentId}" is not allowed to ` +
      `${operation === 'fs_read' ? 'read sensitive path' : 'modify protected path'} ` +
      `"${targetPath}" (matched rule: "${matchedRule}")${detail ? ` — ${detail}` : ''}`,
    )
    this.name = 'ProtectedPathError'
    this.agentId = agentId
    this.targetPath = targetPath
    this.matchedRule = matchedRule
    this.operation = operation
  }
}

/**
 * Resolves a file path strictly inside the agent's isolated workspace directory,
 * checking both lexical traversal (`..`) and symlink resolution (`realpathSync`).
 */
export function resolvePathInWorkspace(workspaceAbsPath: string, requestedPath: string): string {
  mkdirSync(workspaceAbsPath, { recursive: true })
  const wsReal = realpathSync(workspaceAbsPath)
  const candidate = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(wsReal, requestedPath)

  const rel = relative(wsReal, candidate)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new WorkspaceBoundaryError(
      `WORKSPACE_BOUNDARY_VIOLATION: Path "${requestedPath}" escapes agent workspace "${wsReal}"`,
    )
  }

  // If the target or its parent already exists, verify realpath doesn't escape via symlink
  const checkTarget = existsSync(candidate) ? candidate : dirname(candidate)
  if (existsSync(checkTarget)) {
    const targetReal = realpathSync(checkTarget)
    const realRel = relative(wsReal, targetReal)
    if (realRel.startsWith('..') || isAbsolute(realRel)) {
      throw new WorkspaceBoundaryError(
        `WORKSPACE_BOUNDARY_VIOLATION: Symlinked path "${requestedPath}" escapes agent workspace "${wsReal}"`,
      )
    }
  }

  return candidate
}

function normalizePosixRel(p: string): string {
  return p.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/^\/+/, '').replace(/\/+$/, '')
}

function resolveNearestRealPath(targetAbsPath: string): string {
  const missingSegments: string[] = []
  let probe = resolve(targetAbsPath)
  while (!existsSync(probe)) {
    const parent = dirname(probe)
    if (parent === probe) break
    missingSegments.unshift(basename(probe))
    probe = parent
  }
  const realBase = existsSync(probe) ? realpathSync(probe) : probe
  return missingSegments.length > 0 ? join(realBase, ...missingSegments) : realBase
}

function normalizeCaseForPlatform(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p
}

export function isSelfDevAgent(agent: Pick<AlfredAgentDefinition, 'id' | 'workspace'>): boolean {
  return agent.id === 'alfred-self-coder' || agent.workspace.trim() === '.'
}

function safeRealpath(dirPath: string): string {
  return existsSync(dirPath) ? realpathSync(dirPath) : resolve(dirPath)
}

/**
 * Checks whether `targetAbsPath` (lexically or via symlink resolution) matches any rule in `protectedPaths`.
 */
export function matchProtectedPath(
  workspaceAbsPath: string,
  targetAbsPath: string,
  protectedPaths?: readonly string[],
): string | null {
  if (!protectedPaths || protectedPaths.length === 0) return null
  const wsReal = safeRealpath(workspaceAbsPath)
  const candidates = [
    normalizePosixRel(relative(wsReal, targetAbsPath)),
    normalizePosixRel(relative(wsReal, resolveNearestRealPath(targetAbsPath))),
  ]

  for (const rule of protectedPaths) {
    const cleanRule = normalizeCaseForPlatform(normalizePosixRel(rule))
    if (!cleanRule) continue
    for (const rawRel of candidates) {
      if (!rawRel || rawRel === '.' || rawRel.startsWith('..')) continue
      const rel = normalizeCaseForPlatform(rawRel)
      if (rel === cleanRule || rel.startsWith(`${cleanRule}/`)) {
        return rule
      }
    }
  }
  return null
}

function isSensitiveReadPath(
  workspaceAbsPath: string,
  targetAbsPath: string,
  agent: Pick<AlfredAgentDefinition, 'workspace' | 'protectedPaths'>,
): string | null {
  const wsReal = safeRealpath(workspaceAbsPath)
  const candidates = [
    normalizePosixRel(relative(wsReal, targetAbsPath)),
    normalizePosixRel(relative(wsReal, resolveNearestRealPath(targetAbsPath))),
  ]
  const protectsStore =
    agent.workspace.trim() === '.' ||
    Boolean(agent.protectedPaths?.some((r) => normalizePosixRel(r).toLowerCase() === 'store'))

  for (const rawRel of candidates) {
    if (!rawRel || rawRel === '.' || rawRel.startsWith('..')) continue
    const base = basename(rawRel)
    if (/^\.env(?:\.(?!example$).+|~)?$/i.test(base)) {
      return '.env'
    }
    const lower = rawRel.toLowerCase()
    if (protectsStore && (lower === 'store' || lower.startsWith('store/'))) {
      return 'store/'
    }
  }
  return null
}

/**
 * Enforces selective read protection: source/config files remain readable while
 * secrets (`.env`, `.env.*` except `.env.example`) and `store/` are blocked.
 */
export function assertReadAllowed(
  agent: Pick<AlfredAgentDefinition, 'id' | 'workspace' | 'workspaceAbsPath' | 'protectedPaths'>,
  targetAbsPath: string,
  requestedPath: string,
): void {
  const matched = isSensitiveReadPath(agent.workspaceAbsPath, targetAbsPath, agent)
  if (matched) {
    throw new ProtectedPathError(agent.id, requestedPath, matched, 'fs_read')
  }
}

/**
 * Enforces `protectedPaths` write protection on `fs_write`.
 */
export function assertWriteAllowed(
  agent: Pick<AlfredAgentDefinition, 'id' | 'workspaceAbsPath' | 'protectedPaths'>,
  targetAbsPath: string,
  requestedPath: string,
): void {
  const matched = matchProtectedPath(agent.workspaceAbsPath, targetAbsPath, agent.protectedPaths)
  if (matched) {
    throw new ProtectedPathError(agent.id, requestedPath, matched, 'fs_write')
  }
}

export const SELF_DEV_BRANCH_RE = /^(?:feat|fix)\/self-[a-z0-9][a-z0-9._/-]{0,79}$/

/**
 * Validates that a branch name conforms strictly to `feat/self-*` or `fix/self-*`
 * without path traversal or git ref ambiguities.
 */
export function isValidSelfDevBranch(branch: string): boolean {
  const clean = branch.trim()
  if (!SELF_DEV_BRANCH_RE.test(clean)) return false
  if (clean.includes('..') || clean.includes('//')) return false
  if (clean.startsWith('-') || clean.endsWith('.') || clean.endsWith('/') || clean.endsWith('.lock')) {
    return false
  }
  return true
}

const FORBIDDEN_GIT_BRANCH_RE = /^(?:main|master)$/i
const GIT_GLOBAL_FLAGS_WITH_VALUE = new Set([
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--exec-path',
  '--config-env',
])

function normalizeBranchRef(raw: string): string {
  return raw
    .trim()
    .replace(/^\+/, '')
    .replace(/^refs\/heads\//i, '')
    .replace(/^refs\/remotes\/origin\//i, '')
    .replace(/^origin\//i, '')
}

function isProtectedBranchName(branch: string, protectedBranches: readonly string[]): boolean {
  const clean = normalizeBranchRef(branch)
  if (!clean) return false
  if (FORBIDDEN_GIT_BRANCH_RE.test(clean)) return true
  const lower = clean.toLowerCase()
  return protectedBranches.some((b) => normalizeBranchRef(b).toLowerCase() === lower)
}

export interface GitPolicyOptions {
  agentId?: string
  currentBranch?: string | null
  protectedBranches?: readonly string[]
  requireSelfDevBranch?: boolean
  protectedPaths?: readonly string[]
  workspaceAbsPath?: string
}

/**
 * Resolves the active git branch in `cwd`, or `null` when `cwd` is not a git repo or HEAD is detached/unborn.
 */
export function getCurrentGitBranch(cwd: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    return out || null
  } catch {
    return null
  }
}

/**
 * Validates git arguments to enforce workspace isolation, forbid destructive operations
 * (`push --force`, `reset --hard`), protect `main`/`master` (and `feat/alfred-core` for self-dev),
 * require `feat/self-*` / `fix/self-*` branches for self-dev mutations, and protect `protectedPaths`
 * against `checkout --` / `restore` / `apply`.
 */
export function validateGitArgs(args: readonly string[], opts: GitPolicyOptions = {}): void {
  if (!Array.isArray(args) || args.length === 0) {
    throw new Error('git tool requires a non-empty "args" array')
  }
  const normalized = args.map((a) => String(a).trim())

  for (const arg of normalized) {
    if (arg === '-C' || /^-C.+/.test(arg) || arg.startsWith('--git-dir') || arg.startsWith('--work-tree')) {
      throw new WorkspaceBoundaryError(`GIT_POLICY_VIOLATION: Flag "${arg}" is forbidden in isolated workspace`)
    }
  }

  let subcmd = ''
  let subcmdIndex = -1
  for (let i = 0; i < normalized.length; i++) {
    const tok = normalized[i]
    if (!tok) continue
    if (GIT_GLOBAL_FLAGS_WITH_VALUE.has(tok)) {
      i += 1
      continue
    }
    if (tok.startsWith('-')) continue
    subcmd = tok.toLowerCase()
    subcmdIndex = i
    break
  }

  if (!subcmd) {
    throw new Error('git tool requires a valid git subcommand')
  }

  const subcmdArgs = normalized.slice(subcmdIndex + 1)
  const protectedBranches = opts.protectedBranches ?? []
  const agentId = opts.agentId ?? 'git'

  if (subcmd === 'reset') {
    if (subcmdArgs.some((tok) => tok === '--hard' || tok.startsWith('--hard='))) {
      throw new Error('GIT_POLICY_VIOLATION: "git reset --hard" is strictly forbidden')
    }
  }

  if (subcmd === 'apply' && opts.protectedPaths && opts.protectedPaths.length > 0) {
    throw new ProtectedPathError(
      agentId,
      subcmdArgs.join(' ') || 'apply',
      opts.protectedPaths[0],
      'git',
      '"git apply" cannot be used when protectedPaths are configured',
    )
  }

  if (subcmd === 'checkout' || subcmd === 'switch') {
    const dashDashIdx = subcmdArgs.indexOf('--')
    const branchSection = dashDashIdx >= 0 ? subcmdArgs.slice(0, dashDashIdx) : subcmdArgs
    const pathSection = dashDashIdx >= 0 ? subcmdArgs.slice(dashDashIdx + 1) : []

    if (opts.protectedPaths && opts.workspaceAbsPath) {
      const checkPaths = pathSection.length > 0 ? pathSection : branchSection.filter((t) => !t.startsWith('-'))
      for (const p of checkPaths) {
        const abs = resolve(opts.workspaceAbsPath, p)
        const matched = matchProtectedPath(opts.workspaceAbsPath, abs, opts.protectedPaths)
        if (matched) {
          throw new ProtectedPathError(agentId, p, matched, 'git')
        }
      }
    }

    let createdBranch: string | null = null
    let expectingCreatedBranch = false
    const otherPositionals: string[] = []

    for (let i = 0; i < branchSection.length; i++) {
      const tok = branchSection[i]
      if (!tok) continue
      if (expectingCreatedBranch) {
        createdBranch = tok
        expectingCreatedBranch = false
        continue
      }
      if (tok === '-b' || tok === '-B' || tok === '-c' || tok === '-C' || tok === '--create' || tok === '--force-create') {
        expectingCreatedBranch = true
        continue
      }
      if (/^-[bBcC].+/.test(tok)) {
        createdBranch = tok.slice(2)
        continue
      }
      if (tok.startsWith('--create=') || tok.startsWith('--force-create=')) {
        createdBranch = tok.split('=')[1] ?? ''
        continue
      }
      if (tok.startsWith('-')) continue
      otherPositionals.push(tok)
    }

    if (expectingCreatedBranch) {
      throw new Error('GIT_POLICY_VIOLATION: Branch creation flag requires a branch name')
    }

    if (createdBranch !== null) {
      if (isProtectedBranchName(createdBranch, protectedBranches)) {
        throw new Error(`GIT_POLICY_VIOLATION: Creating protected branch "${createdBranch}" is forbidden`)
      }
      if (opts.requireSelfDevBranch && !isValidSelfDevBranch(createdBranch)) {
        throw new Error(
          `GIT_POLICY_VIOLATION: Self-dev branch "${createdBranch}" must match "feat/self-*" or "fix/self-*"`,
        )
      }
    } else {
      for (const tok of otherPositionals) {
        if (isProtectedBranchName(tok, protectedBranches)) {
          throw new Error(`GIT_POLICY_VIOLATION: Switching to "${tok}" branch is strictly forbidden`)
        }
      }
    }
  }

  if (subcmd === 'restore' && opts.protectedPaths && opts.workspaceAbsPath) {
    for (const tok of subcmdArgs) {
      if (!tok || tok === '--' || tok.startsWith('-')) continue
      const abs = resolve(opts.workspaceAbsPath, tok)
      const matched = matchProtectedPath(opts.workspaceAbsPath, abs, opts.protectedPaths)
      if (matched) {
        throw new ProtectedPathError(agentId, tok, matched, 'git')
      }
    }
  }

  if (subcmd === 'branch') {
    const hasMutatingFlag = subcmdArgs.some(
      (tok) => tok === '-f' || tok === '--force' || tok === '-D' || tok === '-d' || tok === '--delete' || tok === '-m' || tok === '-M',
    )
    if (hasMutatingFlag) {
      for (const tok of subcmdArgs) {
        if (tok.startsWith('-')) continue
        if (isProtectedBranchName(tok, protectedBranches)) {
          throw new Error(`GIT_POLICY_VIOLATION: Modifying or deleting protected branch "${tok}" is forbidden`)
        }
      }
    }
  }

  if (subcmd === 'update-ref') {
    for (const tok of subcmdArgs) {
      if (tok.startsWith('-')) continue
      if (isProtectedBranchName(tok, protectedBranches)) {
        throw new Error(`GIT_POLICY_VIOLATION: Updating protected ref "${tok}" is forbidden`)
      }
    }
  }

  if (subcmd === 'commit' || subcmd === 'merge' || subcmd === 'rebase' || subcmd === 'cherry-pick' || subcmd === 'revert') {
    const cur = opts.currentBranch
    if (cur && isProtectedBranchName(cur, protectedBranches)) {
      throw new Error(`GIT_POLICY_VIOLATION: Direct "${subcmd}" on protected branch "${cur}" is strictly forbidden`)
    }
    if (opts.requireSelfDevBranch) {
      if (!cur || cur === 'HEAD' || !isValidSelfDevBranch(cur)) {
        throw new Error(
          `GIT_POLICY_VIOLATION: "${subcmd}" requires an active "feat/self-*" or "fix/self-*" branch (current: "${cur ?? 'unknown'}")`,
        )
      }
    }
  }

  if (subcmd === 'push') {
    const positionals: string[] = []
    for (const tok of subcmdArgs) {
      if (
        tok === '--force' ||
        tok === '-f' ||
        /^-[a-zA-Z]*f[a-zA-Z]*$/.test(tok) ||
        tok.startsWith('--force-with-lease') ||
        tok === '--force-if-includes' ||
        tok === '--all' ||
        tok === '--mirror'
      ) {
        throw new Error(`GIT_POLICY_VIOLATION: Force or wildcard push ("${tok}") is forbidden`)
      }
      if (tok.startsWith('+')) {
        throw new Error(`GIT_POLICY_VIOLATION: Force push via "+" refspec ("${tok}") is forbidden`)
      }
      if (tok.startsWith('-')) continue
      positionals.push(tok)
    }

    const refspecs =
      positionals.length >= 2
        ? positionals.slice(1)
        : (positionals.length === 1 && (positionals[0].includes(':') || isProtectedBranchName(positionals[0], protectedBranches)))
          ? positionals
          : []

    if (refspecs.length > 0) {
      for (const refspec of refspecs) {
        const parts = refspec.split(':')
        const rawTarget = parts.length > 1 ? parts[parts.length - 1] : parts[0]
        if (parts.length > 1 && rawTarget === '') {
          throw new Error(`GIT_POLICY_VIOLATION: Deleting remote branch via "${refspec}" is forbidden`)
        }
        const resolved = rawTarget === 'HEAD' && opts.currentBranch ? opts.currentBranch : rawTarget
        const normTarget = normalizeBranchRef(resolved)
        if (isProtectedBranchName(normTarget, protectedBranches)) {
          throw new Error(`GIT_POLICY_VIOLATION: Pushing to "${normTarget}" is strictly forbidden`)
        }
        if (opts.requireSelfDevBranch && !isValidSelfDevBranch(normTarget)) {
          throw new Error(
            `GIT_POLICY_VIOLATION: Self-dev push target "${normTarget}" must match "feat/self-*" or "fix/self-*"`,
          )
        }
      }
    } else if (opts.requireSelfDevBranch) {
      const cur = opts.currentBranch
      if (!cur || cur === 'HEAD' || isProtectedBranchName(cur, protectedBranches) || !isValidSelfDevBranch(cur)) {
        throw new Error(
          `GIT_POLICY_VIOLATION: Pushing from protected or non-self-dev branch "${cur ?? 'unknown'}" is forbidden`,
        )
      }
    }
  }
}

const FORBIDDEN_BASH_PATTERNS: readonly RegExp[] = [
  /\bsudo\b/i,
  /\bgit\s+(?:checkout|switch)\s+(?:-[a-zA-Z]+\s+)*(?:main|master)\b/i,
  /\bgit\s+push\b[^\n;&|]*\b(?:main|master)\b/i,
  /\bgit\b[^\n;&|]*\bpush\b[^\n;&|]*(?:--force(?:-with-lease)?|--force-if-includes|\s-[a-zA-Z]*f[a-zA-Z]*\b)/i,
  /\bgit\b[^\n;&|]*\breset\b[^\n;&|]*--hard\b/i,
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+\/(?:\s|$)/i,
]

const FORBIDDEN_WHITELIST_BASH_CHARS_RE = /[;&|`$<>()\r\n\0'"\\*?[\]{}~#!%^]/

/**
 * Validates a command strictly against an agent's `allowedBashCommands` template list,
 * rejecting any shell metacharacters, chaining, quotes, or invalid `<self-branch>` arguments.
 * Returns the parsed `argv` array for shell-less `execFileSync` execution.
 */
export function validateWhitelistedBashCommand(
  command: string,
  allowedTemplates: readonly string[],
  agentId: string,
): string[] {
  const trimmed = command.trim()
  if (!trimmed) {
    throw new Error('BASH_WHITELIST_VIOLATION: Command must be non-empty')
  }
  if (FORBIDDEN_WHITELIST_BASH_CHARS_RE.test(trimmed)) {
    throw new Error(`BASH_WHITELIST_VIOLATION: Shell metacharacters or chaining are forbidden in "${trimmed}"`)
  }
  if (allowedTemplates.length === 0) {
    throw new Error(`BASH_WHITELIST_VIOLATION: Agent "${agentId}" has an empty allowedBashCommands whitelist`)
  }

  const argv = trimmed.split(/\s+/)
  for (const template of allowedTemplates) {
    const tmplTokens = template.trim().split(/\s+/)
    if (tmplTokens.length !== argv.length) continue
    let matched = true
    for (let i = 0; i < tmplTokens.length; i++) {
      if (tmplTokens[i] === '<self-branch>') {
        if (!isValidSelfDevBranch(argv[i])) {
          matched = false
          break
        }
      } else if (argv[i] !== tmplTokens[i]) {
        matched = false
        break
      }
    }
    if (matched) return argv
  }

  throw new Error(`BASH_WHITELIST_VIOLATION: Command "${trimmed}" is not in allowedBashCommands for "${agentId}"`)
}

export function resolveBashExecutable(bin: string): string {
  if (process.platform === 'win32' && bin === 'bash') {
    const candidates = [
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    ]
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate
    }
    const pathEntries = (process.env.PATH ?? '').split(';').filter(Boolean)
    for (const entry of pathEntries) {
      if (!/git/i.test(entry)) continue
      const gitRoot = dirname(entry)
      for (const rel of [
        join('bin', 'bash.exe'),
        join('usr', 'bin', 'bash.exe'),
        join('usr', 'bin', 'sh.exe'),
      ]) {
        const probe = join(gitRoot, rel)
        if (existsSync(probe)) return probe
      }
    }
  }
  return bin
}

function buildBashExecEnv(executablePath: string): NodeJS.ProcessEnv | undefined {
  if (process.platform !== 'win32') return undefined
  const exeDir = dirname(executablePath)
  const curPath = process.env.PATH ?? ''
  if (!curPath.toLowerCase().includes(exeDir.toLowerCase())) {
    return { ...process.env, PATH: `${exeDir};${curPath}` }
  }
  return undefined
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const BASH_MUTATING_HINT_RE =
  /(?:(?<![12])>>?|(?<![12])>\||2>(?!&1\b)|&>(?!&[12]\b)|\b(?:rm|del|erase|mv|move|cp|copy|tee|touch|truncate|dd|chmod|chown|ln|install|patch|Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item|Rename-Item|Clear-Content|New-Item|sc|ac|ri|mi|cpi)\b|\bsed\s+[^\n;|&]*-i\b|\bperl\s+[^\n;|&]*-i\b|\b(?:node|tsx|python|python3|ruby|pwsh|powershell|sh|bash)\s+[^\n;|&]*-[ec]\b|\bgit\s+(?:checkout\s+--|restore|apply|clean)\b)/i

/**
 * Validates a general `bash` command against forbidden patterns, `protectedPaths` mutations,
 * `.env` / `store/` reads, and self-dev Git branch rules.
 */
export function validateBashCommand(
  command: string,
  agent: Pick<AlfredAgentDefinition, 'id' | 'workspace' | 'workspaceAbsPath' | 'protectedPaths'>,
  currentBranch?: string | null,
): void {
  for (const pat of FORBIDDEN_BASH_PATTERNS) {
    if (pat.test(command)) {
      throw new Error(`BASH_POLICY_VIOLATION: Command rejected by security filter: ${command}`)
    }
  }

  const normCmd = command.replace(/\\/g, '/')
  const wsPosix = normalizeCaseForPlatform(safeRealpath(agent.workspaceAbsPath).replace(/\\/g, '/').replace(/\/+$/, ''))
  const protectsStore =
    agent.workspace.trim() === '.' ||
    Boolean(agent.protectedPaths?.some((r) => normalizePosixRel(r).toLowerCase() === 'store'))

  const envReadRe = /(?:^|[\s"'`=;(|&<>:/])\.env(?:\.(?!example\b)[a-z0-9._-]+|~)?(?=$|[\s"'`;)|&<>])/i
  if (envReadRe.test(normCmd)) {
    throw new ProtectedPathError(agent.id, '.env', '.env', 'bash', 'reading or modifying .env via bash is forbidden')
  }

  if (protectsStore) {
    const storePrefix = wsPosix ? `(?:${escapeRegExp(wsPosix)}/|\\.?\\.?/)?` : '(?:\\.?\\.?/)?'
    const storeRe = new RegExp(`(?:^|[\\s"'\`=;(|&<>])${storePrefix}store(?:/|$|[\\s"'\`;)|&<>])`, 'i')
    if (storeRe.test(normCmd)) {
      throw new ProtectedPathError(agent.id, 'store/', 'store/', 'bash', 'accessing store/ via bash is forbidden')
    }
  }

  if (agent.protectedPaths && agent.protectedPaths.length > 0 && BASH_MUTATING_HINT_RE.test(normCmd)) {
    for (const rule of agent.protectedPaths) {
      const clean = normalizePosixRel(rule)
      if (!clean) continue
      const isDir = rule.trim().endsWith('/')
      const escapedRule = escapeRegExp(clean)
      const wsOpt = wsPosix ? `(?:${escapeRegExp(wsPosix)}/|\\.?\\.?/)?` : '(?:\\.?\\.?/)?'
      const tail = isDir ? '(?:/|$|[\\s"\'`;)|&<>])' : '(?=$|[\\s"\'`;)|&<>])'
      const ruleRe = new RegExp(`(?:^|[\\s"'\`=;(|&<>])${wsOpt}${escapedRule}${tail}`, 'i')
      if (ruleRe.test(normCmd)) {
        throw new ProtectedPathError(agent.id, clean, rule, 'bash', 'modifying protected path via bash is forbidden')
      }
    }
  }

  if (isSelfDevAgent(agent)) {
    if (/\bgit\b[^\n;&|]*\bpush\b[^\n;&|]*\bfeat\/alfred-core\b/i.test(normCmd)) {
      throw new Error('GIT_POLICY_VIOLATION: Pushing to "feat/alfred-core" via bash is forbidden')
    }
    if (/\bgit\b[^\n;&|]*\b(?:checkout|switch)\b(?![^\n;&|]*\s-(?:[bBcC]|-create|-force-create)\b)[^\n;&|]*\bfeat\/alfred-core\b/i.test(normCmd)) {
      throw new Error('GIT_POLICY_VIOLATION: Switching to "feat/alfred-core" via bash is forbidden')
    }
    if (/\bgit\b[^\n;&|]*\b(?:commit|push|merge|rebase|cherry-pick|revert)\b/i.test(normCmd)) {
      if (currentBranch && !isValidSelfDevBranch(currentBranch)) {
        throw new Error(
          `GIT_POLICY_VIOLATION: Git mutation via bash requires a "feat/self-*" or "fix/self-*" branch (current: "${currentBranch}")`,
        )
      }
    }
  }
}

export interface ExecuteToolContext {
  agent: AlfredAgentDefinition
  db: Database.Database
  chatId?: string
  projectRoot?: string
}

/**
 * Layer 2 of Tool Whitelist enforcement:
 * Verifies at runtime that `toolName` is in `agent.tools` and that its owning module is active,
 * then executes the tool strictly confined to `agent.workspaceAbsPath` and `agent.memoryNamespace`.
 */
export function executeWhitelistedTool(
  ctx: ExecuteToolContext,
  toolName: string,
  rawArgs: Record<string, unknown>,
): string {
  const allowedTools = ctx.agent.tools
  if (!allowedTools.includes(toolName as AllowedToolName)) {
    throw new ToolNotAllowedError(ctx.agent.id, toolName, allowedTools)
  }

  const moduleOwner = resolveToolOwnerModule(toolName, {
    db: ctx.db,
    projectRoot: ctx.projectRoot,
  })
  if (moduleOwner && !moduleOwner.active) {
    return buildModuleDisabledResponse(toolName, moduleOwner.moduleId)
  }

  switch (toolName as AllowedToolName) {
    case 'fs_read': {
      const reqPath = typeof rawArgs.path === 'string' ? rawArgs.path : '.'
      const target = resolvePathInWorkspace(ctx.agent.workspaceAbsPath, reqPath)
      assertReadAllowed(ctx.agent, target, reqPath)
      if (!existsSync(target)) {
        return `Error: File or directory not found: ${reqPath}`
      }
      const st = statSync(target)
      if (st.isDirectory()) {
        const entries = readdirSync(target, { withFileTypes: true })
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort()
        return entries.join('\n') || '(empty directory)'
      }
      return readFileSync(target, 'utf-8').slice(0, 64_000)
    }

    case 'fs_write': {
      const reqPath = typeof rawArgs.path === 'string' ? rawArgs.path.trim() : ''
      if (!reqPath) throw new Error('fs_write requires a non-empty "path"')
      const content = typeof rawArgs.content === 'string' ? rawArgs.content : ''
      if (ctx.agent.id === 'alfred-batch') {
        const confinedTarget = resolveBatchConfinedPath(ctx.agent.workspaceAbsPath, reqPath)
        mkdirSync(dirname(confinedTarget), { recursive: true })
        writeFileSync(confinedTarget, content, 'utf-8')
        return `OK: Wrote ${Buffer.byteLength(content, 'utf-8')} bytes to ${reqPath}`
      }
      const target = resolvePathInWorkspace(ctx.agent.workspaceAbsPath, reqPath)
      assertWriteAllowed(ctx.agent, target, reqPath)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content, 'utf-8')
      return `OK: Wrote ${Buffer.byteLength(content, 'utf-8')} bytes to ${reqPath}`
    }

    case 'git': {
      const args = Array.isArray(rawArgs.args) ? rawArgs.args.map(String) : []
      const selfDev = isSelfDevAgent(ctx.agent)
      const currentBranch = getCurrentGitBranch(ctx.agent.workspaceAbsPath)
      validateGitArgs(args, {
        agentId: ctx.agent.id,
        currentBranch,
        protectedBranches: selfDev ? ['feat/alfred-core'] : [],
        requireSelfDevBranch: selfDev,
        protectedPaths: ctx.agent.protectedPaths,
        workspaceAbsPath: ctx.agent.workspaceAbsPath,
      })
      mkdirSync(ctx.agent.workspaceAbsPath, { recursive: true })
      const out = execFileSync('git', args, {
        cwd: ctx.agent.workspaceAbsPath,
        encoding: 'utf-8',
        timeout: 15_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return out.trim() || '(git command exited 0 with no output)'
    }

    case 'bash': {
      const command = typeof rawArgs.command === 'string' ? rawArgs.command.trim() : ''
      if (!command) throw new Error('bash tool requires a non-empty "command"')

      if (ctx.agent.allowedBashCommands !== undefined) {
        const argv = validateWhitelistedBashCommand(command, ctx.agent.allowedBashCommands, ctx.agent.id)
        mkdirSync(ctx.agent.workspaceAbsPath, { recursive: true })
        const executable = resolveBashExecutable(argv[0])
        const execEnv = buildBashExecEnv(executable)
        const out = execFileSync(executable, argv.slice(1), {
          cwd: ctx.agent.workspaceAbsPath,
          encoding: 'utf-8',
          timeout: ctx.agent.bashTimeoutMs ?? 180_000,
          stdio: ['ignore', 'pipe', 'pipe'],
          ...(execEnv ? { env: execEnv } : {}),
        })
        return out.trim().slice(0, 32_000) || '(command exited 0)'
      }

      const currentBranch = isSelfDevAgent(ctx.agent) ? getCurrentGitBranch(ctx.agent.workspaceAbsPath) : null
      validateBashCommand(command, ctx.agent, currentBranch)
      mkdirSync(ctx.agent.workspaceAbsPath, { recursive: true })
      const out = execSync(command, {
        cwd: ctx.agent.workspaceAbsPath,
        encoding: 'utf-8',
        timeout: ctx.agent.bashTimeoutMs ?? 30_000,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(process.platform !== 'win32' ? { shell: '/bin/sh' } : {}),
      })
      return out.trim().slice(0, 32_000) || '(command exited 0)'
    }

    case 'memory': {
      const action = typeof rawArgs.action === 'string' ? rawArgs.action : 'read'
      const namespace = ctx.agent.memoryNamespace
      const chatId = ctx.chatId ?? ctx.agent.discordChannelId ?? namespace
      const nowSec = Math.floor(Date.now() / 1000)

      if (action === 'save') {
        const content = typeof rawArgs.content === 'string' ? rawArgs.content.trim() : ''
        if (!content) throw new Error('memory save requires non-empty "content"')
        const rawCat = typeof rawArgs.category === 'string' ? rawArgs.category : 'warm'
        const category = rawCat === 'hot' || rawCat === 'cold' ? rawCat : 'warm'
        const res = ctx.db.prepare(`
          INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at, agent_id, category)
          VALUES (?, ?, 'semantic', 1.0, ?, ?, ?, ?)
        `).run(chatId, content, nowSec, nowSec, namespace, category)
        return `OK: Memory saved in namespace "${namespace}" (id=${String(res.lastInsertRowid)})`
      }

      if (action === 'search') {
        const query = typeof rawArgs.content === 'string' ? rawArgs.content.trim() : ''
        const rows = ctx.db.prepare(`
          SELECT id, content, category, created_at
          FROM memories
          WHERE agent_id = ? AND retracted_at IS NULL AND content LIKE ?
          ORDER BY created_at DESC
          LIMIT 10
        `).all(namespace, `%${query}%`) as Array<{ id: number; content: string; category: string }>
        if (rows.length === 0) return '(no matching memories in namespace)'
        return rows.map((r) => `[#${r.id} ${r.category}] ${r.content}`).join('\n')
      }

      // action === 'read'
      const rows = ctx.db.prepare(`
        SELECT id, content, category, created_at
        FROM memories
        WHERE agent_id = ? AND retracted_at IS NULL
        ORDER BY created_at DESC
        LIMIT 10
      `).all(namespace) as Array<{ id: number; content: string; category: string }>
      if (rows.length === 0) return '(no memories stored in namespace)'
      return rows.map((r) => `[#${r.id} ${r.category}] ${r.content}`).join('\n')
    }

    case 'cli_manage': {
      if (ctx.agent.id !== 'alfred-ops') {
        throw new ToolNotAllowedError(
          ctx.agent.id,
          toolName,
          allowedTools.filter((t) => t !== 'cli_manage'),
        )
      }
      throw new Error('cli_manage is asynchronous; invoke executeWhitelistedToolAsync()')
    }

    case 'system_storage': {
      if (ctx.agent.id !== 'alfred-ops') {
        throw new ToolNotAllowedError(
          ctx.agent.id,
          toolName,
          allowedTools.filter((t) => t !== 'system_storage'),
        )
      }
      throw new Error('system_storage is asynchronous; invoke executeWhitelistedToolAsync()')
    }

    case 'module_manage': {
      if (!isModuleManageAuthorized(ctx.agent.id)) {
        throw new ToolNotAllowedError(
          ctx.agent.id,
          toolName,
          allowedTools.filter((t) => t !== 'module_manage'),
        )
      }
      throw new Error('module_manage is asynchronous; invoke executeWhitelistedToolAsync()')
    }

    case 'batch_submit':
    case 'batch_status':
    case 'batch_list':
    case 'batch_cancel': {
      throw new Error(`${toolName} is asynchronous; invoke executeWhitelistedToolAsync()`)
    }
  }
}

/**
 * Async tool executor extending `executeWhitelistedTool` for async lifecycle tools (`cli_manage`, `system_storage`, `module_manage`, `batch_*`).
 */
export async function executeWhitelistedToolAsync(
  ctx: ExecuteToolContext,
  toolName: string,
  rawArgs: Record<string, unknown>,
  opts?: { env?: Record<string, string | undefined>; processRunner?: CliProcessRunner },
): Promise<string> {
  const allowedTools = ctx.agent.tools
  if (!allowedTools.includes(toolName as AllowedToolName)) {
    throw new ToolNotAllowedError(ctx.agent.id, toolName, allowedTools)
  }

  const moduleOwner = resolveToolOwnerModule(toolName, {
    db: ctx.db,
    projectRoot: ctx.projectRoot,
  })
  if (moduleOwner && !moduleOwner.active) {
    return buildModuleDisabledResponse(toolName, moduleOwner.moduleId)
  }

  if (toolName === 'module_manage') {
    if (!isModuleManageAuthorized(ctx.agent.id)) {
      throw new ToolNotAllowedError(
        ctx.agent.id,
        toolName,
        allowedTools.filter((t) => t !== 'module_manage'),
      )
    }

    const action = typeof rawArgs.action === 'string' ? rawArgs.action.trim().toLowerCase() : 'list'
    const targetId = typeof rawArgs.target_id === 'string' ? rawArgs.target_id.trim() : ''
    const modOpts = {
      db: ctx.db,
      projectRoot: ctx.projectRoot,
      env: opts?.env,
    }

    if (action === 'list') {
      return JSON.stringify(
        {
          ok: true,
          modules: listModules(modOpts),
          agentPackages: listAgentPackages(modOpts),
        },
        null,
        2,
      )
    }
    if (action === 'install_module' || action === 'enable_module') {
      const result = enableModule(targetId, {
        ...modOpts,
        withDependencies: rawArgs.with_dependencies !== false,
      })
      return JSON.stringify({ ok: true, ...result }, null, 2)
    }
    if (action === 'disable_module') {
      const result = disableModule(targetId, {
        ...modOpts,
        disableDependentAgents: rawArgs.disable_dependent_agents === true,
      })
      return JSON.stringify({ ok: true, ...result }, null, 2)
    }
    if (action === 'install_agent') {
      const result = installAgentPackage(targetId, {
        ...modOpts,
        enableRequiredModules: rawArgs.with_dependencies !== false,
      })
      return JSON.stringify({ ok: true, ...result }, null, 2)
    }
    if (action === 'enable_agent') {
      const result = toggleAgentPackage(targetId, true, modOpts)
      return JSON.stringify({ ok: true, ...result }, null, 2)
    }
    if (action === 'disable_agent') {
      const result = toggleAgentPackage(targetId, false, modOpts)
      return JSON.stringify({ ok: true, ...result }, null, 2)
    }
    throw new Error(
      `module_manage: unsupported action "${action}". Allowed: list, install_module, enable_module, disable_module, install_agent, enable_agent, disable_agent`,
    )
  }

  if (toolName === 'cli_manage') {
    if (ctx.agent.id !== 'alfred-ops') {
      throw new ToolNotAllowedError(
        ctx.agent.id,
        toolName,
        allowedTools.filter((t) => t !== 'cli_manage'),
      )
    }

    const action = typeof rawArgs.action === 'string' ? rawArgs.action.trim().toLowerCase() : 'status'
    if (action === 'status') {
      const clis = await getCliInventory({ env: opts?.env, processRunner: opts?.processRunner })
      return JSON.stringify({ ok: true, clis }, null, 2)
    }
    if (action === 'install' || action === 'update') {
      const provider = typeof rawArgs.provider === 'string' ? rawArgs.provider : ''
      const result = await installOrUpdateCli(provider, { env: opts?.env, processRunner: opts?.processRunner })
      return JSON.stringify(result, null, 2)
    }
    if (action === 'remove') {
      const provider = typeof rawArgs.provider === 'string' ? rawArgs.provider : ''
      const result = await removeCli(provider, {
        purgeAuth: rawArgs.purgeAuth === true,
        env: opts?.env,
        processRunner: opts?.processRunner,
      })
      return JSON.stringify(result, null, 2)
    }
    throw new Error(`cli_manage: unsupported action "${action}". Allowed: status, install, update, remove`)
  }

  if (toolName === 'system_storage') {
    if (ctx.agent.id !== 'alfred-ops') {
      throw new ToolNotAllowedError(
        ctx.agent.id,
        toolName,
        allowedTools.filter((t) => t !== 'system_storage'),
      )
    }

    const action = typeof rawArgs.action === 'string' ? rawArgs.action.trim().toLowerCase() : 'status'
    if (action === 'status') {
      const system = await collectSystemTelemetry({
        projectRoot: ctx.agent.workspaceAbsPath,
        env: opts?.env,
      })
      return JSON.stringify({ ok: true, system }, null, 2)
    }
    if (action === 'cleanup') {
      const before = await collectSystemTelemetry({
        projectRoot: ctx.agent.workspaceAbsPath,
        env: opts?.env,
      })
      const cleanup = await runHousekeeping({
        db: ctx.db,
        projectRoot: ctx.agent.workspaceAbsPath,
        env: opts?.env,
        diskUsedPct: before.health.maxDiskUsedPct,
        diskWarnPct: before.thresholds.diskWarnPct,
      })
      const system = await collectSystemTelemetry({
        projectRoot: ctx.agent.workspaceAbsPath,
        env: opts?.env,
      })
      return JSON.stringify({ ok: true, cleanup, system }, null, 2)
    }
    throw new Error(`system_storage: unsupported action "${action}". Allowed: status, cleanup`)
  }

  if (toolName === 'batch_submit') {
    const inputPath = typeof rawArgs.input_path === 'string' ? rawArgs.input_path.trim() : ''
    if (!inputPath) throw new Error('batch_submit requires a non-empty "input_path"')
    const provider =
      typeof rawArgs.provider === 'string' && rawArgs.provider.trim()
        ? (rawArgs.provider.trim() as RequestedBatchProvider)
        : 'auto'
    const model = typeof rawArgs.model === 'string' && rawArgs.model.trim() ? rawArgs.model.trim() : undefined
    const taskType =
      typeof rawArgs.task_type === 'string' && rawArgs.task_type.trim()
        ? (rawArgs.task_type.trim() as BatchTaskType)
        : undefined
    const euOnly = rawArgs.eu_only === true
    const job = await submitBatchJob({
      db: ctx.db,
      inputPath,
      provider,
      model,
      taskType,
      euOnly,
      agentId: ctx.agent.id,
      agentDailyLimitUsd: ctx.agent.dailyBudgetUsd,
      discordChannelId: ctx.chatId ?? ctx.agent.discordChannelId ?? null,
      projectRoot: ctx.agent.workspaceAbsPath,
      env: opts?.env,
    })
    return JSON.stringify({ ok: true, job }, null, 2)
  }

  if (toolName === 'batch_status') {
    const batchId = typeof rawArgs.batch_id === 'string' ? rawArgs.batch_id.trim() : ''
    if (!batchId) throw new Error('batch_status requires a non-empty "batch_id"')
    if (rawArgs.poll === true) {
      const res = await pollBatchJob({
        db: ctx.db,
        batchId,
        projectRoot: ctx.agent.workspaceAbsPath,
        env: opts?.env,
      })
      return JSON.stringify({ ok: true, ...res }, null, 2)
    }
    const job = getBatchJobById(ctx.db, batchId)
    if (!job) {
      return JSON.stringify({ ok: false, error: `Batch job not found: ${batchId}` })
    }
    return JSON.stringify({ ok: true, job }, null, 2)
  }

  if (toolName === 'batch_list') {
    const status = typeof rawArgs.status === 'string' ? rawArgs.status.trim() : undefined
    const limit = typeof rawArgs.limit === 'number' && Number.isFinite(rawArgs.limit) ? rawArgs.limit : 20
    const jobs = listBatchJobs(ctx.db, { status, limit })
    return JSON.stringify({ ok: true, count: jobs.length, jobs }, null, 2)
  }

  if (toolName === 'batch_cancel') {
    const batchId = typeof rawArgs.batch_id === 'string' ? rawArgs.batch_id.trim() : ''
    if (!batchId) throw new Error('batch_cancel requires a non-empty "batch_id"')
    const job = await cancelBatchJob({
      db: ctx.db,
      batchId,
      projectRoot: ctx.agent.workspaceAbsPath,
      env: opts?.env,
    })
    return JSON.stringify({ ok: true, job }, null, 2)
  }

  return executeWhitelistedTool(ctx, toolName, rawArgs)
}
