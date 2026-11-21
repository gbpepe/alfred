#!/usr/bin/env node
// Manages Cloudflare DNS CNAME, Tunnel ingress, and optional Access app domain
// for multi-branch test environments: <slug>-test-alfred.<baseDomain>.
// Zero external dependencies; uses Node's built-in fetch.

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ENV_FILE = join(__dirname, '..', '.env.cloudflare')

export function branchToTestSlug(branch) {
  const slug = String(branch || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '')
  if (!slug) throw new Error(`Cannot derive DNS slug from branch: "${branch}"`)
  return slug
}

export function buildTestHostname(branch, baseDomain = 'princicol.co.uk') {
  return `${branchToTestSlug(branch)}-test-alfred.${baseDomain}`
}

function loadCfConfig() {
  const envFile = process.env.ALFRED_CF_ENV_FILE || DEFAULT_ENV_FILE
  const fileVars = {}
  if (existsSync(envFile)) {
    for (const rawLine of readFileSync(envFile, 'utf-8').split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const k = line.slice(0, eq).trim()
      let v = line.slice(eq + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1)
      }
      fileVars[k] = v
    }
  }
  const get = (k, fallback = '') => (process.env[k] || fileVars[k] || fallback).trim()
  return {
    apiToken: get('CF_API_TOKEN'),
    accountId: get('CF_ACCOUNT_ID'),
    tunnelId: get('CF_TUNNEL_ID'),
    zoneId: get('CF_ZONE_ID'),
    baseDomain: get('CF_BASE_DOMAIN', 'princicol.co.uk'),
    accessAppId: get('CF_ACCESS_APP_ID'),
  }
}

async function cfApi(cfg, path, opts = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method: opts.method || 'GET',
    headers: {
      Authorization: `Bearer ${cfg.apiToken}`,
      'Content-Type': 'application/json',
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const data = await res.json()
  if (!res.ok || !data.success) {
    const msg = (data.errors || []).map((e) => `${e.code}: ${e.message}`).join('; ') || `HTTP ${res.status}`
    throw new Error(`Cloudflare API ${opts.method || 'GET'} ${path} failed: ${msg}`)
  }
  return data.result
}

async function upsertDnsCname(cfg, hostname) {
  const target = `${cfg.tunnelId}.cfargotunnel.com`
  const existing = await cfApi(
    cfg,
    `/zones/${cfg.zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`,
  )
  const payload = { type: 'CNAME', name: hostname, content: target, ttl: 1, proxied: true }
  if (Array.isArray(existing) && existing.length > 0) {
    await cfApi(cfg, `/zones/${cfg.zoneId}/dns_records/${existing[0].id}`, { method: 'PUT', body: payload })
  } else {
    await cfApi(cfg, `/zones/${cfg.zoneId}/dns_records`, { method: 'POST', body: payload })
  }
}

async function deleteDnsCname(cfg, hostname) {
  const existing = await cfApi(
    cfg,
    `/zones/${cfg.zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`,
  )
  if (!Array.isArray(existing)) return
  for (const rec of existing) {
    await cfApi(cfg, `/zones/${cfg.zoneId}/dns_records/${rec.id}`, { method: 'DELETE' })
  }
}

async function updateTunnelIngress(cfg, hostname, webPort) {
  const current = await cfApi(cfg, `/accounts/${cfg.accountId}/cfd_tunnel/${cfg.tunnelId}/configurations`)
  const config = current?.config && typeof current.config === 'object' ? { ...current.config } : {}
  const rules = Array.isArray(config.ingress) ? config.ingress.filter((r) => r && r.hostname !== hostname) : []
  const catchAllIdx = rules.findIndex((r) => !r.hostname)
  if (webPort) {
    const newRule = { hostname, service: `http://127.0.0.1:${webPort}`, originRequest: {} }
    if (catchAllIdx >= 0) rules.splice(catchAllIdx, 0, newRule)
    else rules.push(newRule, { service: 'http_status:404' })
  } else if (catchAllIdx < 0) {
    rules.push({ service: 'http_status:404' })
  }
  config.ingress = rules
  await cfApi(cfg, `/accounts/${cfg.accountId}/cfd_tunnel/${cfg.tunnelId}/configurations`, {
    method: 'PUT',
    body: { config },
  })
}

async function syncAccessAppDomain(cfg, hostname, add) {
  if (!cfg.accessAppId) return
  const app = await cfApi(cfg, `/accounts/${cfg.accountId}/access/apps/${cfg.accessAppId}`)
  const existing = Array.isArray(app.self_hosted_domains)
    ? app.self_hosted_domains
    : app.domain
      ? [app.domain]
      : []
  const next = add
    ? Array.from(new Set([...existing, hostname]))
    : existing.filter((d) => d !== hostname)
  if (next.length === 0) return
  await cfApi(cfg, `/accounts/${cfg.accountId}/access/apps/${cfg.accessAppId}`, {
    method: 'PUT',
    body: {
      ...app,
      domain: next[0],
      self_hosted_domains: next,
    },
  })
}

async function main() {
  const [cmd, branch, portArg] = process.argv.slice(2)
  if (!cmd || !branch) {
    console.error('Usage: cf-test-route.mjs <slug|hostname|up|down> <branch> [webPort]')
    process.exit(1)
  }
  const cfg = loadCfConfig()
  if (cmd === 'slug') {
    console.log(branchToTestSlug(branch))
    return
  }
  const hostname = buildTestHostname(branch, cfg.baseDomain)
  if (cmd === 'hostname') {
    console.log(hostname)
    return
  }
  if (!cfg.apiToken || !cfg.accountId || !cfg.tunnelId || !cfg.zoneId) {
    console.log(`[alfred-cf] Cloudflare credentials incomplete; skipping route ${cmd} for ${hostname}`)
    return
  }
  if (cmd === 'up') {
    const webPort = Number(portArg)
    if (!Number.isInteger(webPort) || webPort < 1024 || webPort > 65535) {
      throw new Error(`Invalid webPort: ${portArg}`)
    }
    await upsertDnsCname(cfg, hostname)
    await updateTunnelIngress(cfg, hostname, webPort)
    await syncAccessAppDomain(cfg, hostname, true)
    console.log(`[alfred-cf] Route UP: https://${hostname} -> 127.0.0.1:${webPort}`)
    return
  }
  if (cmd === 'down') {
    await updateTunnelIngress(cfg, hostname, null)
    await deleteDnsCname(cfg, hostname)
    await syncAccessAppDomain(cfg, hostname, false)
    console.log(`[alfred-cf] Route DOWN: ${hostname}`)
    return
  }
  throw new Error(`Unknown command: ${cmd}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(`[alfred-cf][ERROR] ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}
