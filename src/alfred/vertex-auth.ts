import { createSign } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { PROJECT_ROOT } from '../config.js'

export const DEFAULT_GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token'
export const VERTEX_CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform'
export const GCE_METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token'
export const GCE_METADATA_PROJECT_URL =
  'http://metadata.google.internal/computeMetadata/v1/project/project-id'

const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000 // 5 minutes
const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{2,62}$/i

export interface ServiceAccountKey {
  type: string
  project_id?: string
  client_email: string
  private_key: string
  token_uri?: string
}

interface CachedAccessToken {
  accessToken: string
  expiresAtMs: number
}

const tokenCache = new Map<string, CachedAccessToken>()

/**
 * Clears the in-memory Vertex AI OAuth2 token cache (primarily for unit tests).
 */
export function clearVertexTokenCache(): void {
  tokenCache.clear()
}

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

/**
 * Loads and validates a Google Cloud Service Account JSON key file.
 * Relative paths are resolved against `projectRoot`.
 */
export function loadServiceAccountKey(
  credentialsPath: string,
  projectRoot: string = PROJECT_ROOT,
): ServiceAccountKey {
  const cleanPath = credentialsPath.trim()
  if (!cleanPath) {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS path is empty')
  }
  const absPath = isAbsolute(cleanPath) ? cleanPath : resolve(projectRoot, cleanPath)
  if (!existsSync(absPath)) {
    throw new Error(`GOOGLE_APPLICATION_CREDENTIALS file not found: ${absPath}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(absPath, 'utf-8'))
  } catch (err) {
    throw new Error(`Failed to parse GOOGLE_APPLICATION_CREDENTIALS JSON (${absPath}): ${(err as Error).message}`)
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid Service Account JSON (${absPath}): expected a JSON object`)
  }
  const obj = parsed as Record<string, unknown>
  if (obj.type !== 'service_account') {
    throw new Error(
      `Unsupported GOOGLE_APPLICATION_CREDENTIALS type "${String(obj.type ?? '')}" in ${absPath}: expected "service_account"`,
    )
  }
  if (typeof obj.client_email !== 'string' || !obj.client_email.trim()) {
    throw new Error(`Invalid Service Account JSON (${absPath}): missing client_email`)
  }
  if (typeof obj.private_key !== 'string' || !obj.private_key.includes('PRIVATE KEY')) {
    throw new Error(`Invalid Service Account JSON (${absPath}): missing private_key`)
  }

  return {
    type: 'service_account',
    project_id: typeof obj.project_id === 'string' ? obj.project_id.trim() : undefined,
    client_email: obj.client_email.trim(),
    private_key: obj.private_key,
    token_uri: typeof obj.token_uri === 'string' && obj.token_uri.trim()
      ? obj.token_uri.trim()
      : DEFAULT_GOOGLE_TOKEN_URI,
  }
}

/**
 * Builds and signs an RS256 JWT assertion for Google OAuth2 Service Account token exchange.
 */
export function createServiceAccountJwtAssertion(
  sa: ServiceAccountKey,
  nowSec: number = Math.floor(Date.now() / 1000),
  scope: string = VERTEX_CLOUD_PLATFORM_SCOPE,
): string {
  const header = { alg: 'RS256', typ: 'JWT' }
  const audience = sa.token_uri || DEFAULT_GOOGLE_TOKEN_URI
  const payload = {
    iss: sa.client_email,
    sub: sa.client_email,
    scope,
    aud: audience,
    iat: nowSec,
    exp: nowSec + 3600,
  }

  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`
  const signer = createSign('RSA-SHA256')
  signer.update(signingInput)
  signer.end()
  const signature = signer.sign(sa.private_key)
  return `${signingInput}.${base64UrlEncode(signature)}`
}

/**
 * Exchanges a signed Service Account JWT assertion for a short-lived Google OAuth2 access token.
 */
export async function exchangeServiceAccountJwtForToken(
  sa: ServiceAccountKey,
  fetchImpl: typeof fetch = fetch,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<CachedAccessToken> {
  const tokenUri = sa.token_uri || DEFAULT_GOOGLE_TOKEN_URI
  const assertion = createServiceAccountJwtAssertion(sa, nowSec)
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  }).toString()

  const resp = await fetchImpl(tokenUri, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  })

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`Google OAuth2 token exchange failed (${resp.status}) for ${sa.client_email}: ${errText.slice(0, 300)}`)
  }

  const data = (await resp.json()) as { access_token?: string; expires_in?: number }
  if (typeof data.access_token !== 'string' || !data.access_token.trim()) {
    throw new Error(`Google OAuth2 token exchange returned no access_token for ${sa.client_email}`)
  }

  const expiresInSec = typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : 3600
  return {
    accessToken: data.access_token.trim(),
    expiresAtMs: nowSec * 1000 + expiresInSec * 1000,
  }
}

/**
 * Queries the Google Compute Engine (GCE) Metadata Server for the attached VM Service Account token.
 * Returns null when not running on GCE or when the metadata server is unreachable.
 */
export async function fetchGceMetadataToken(
  fetchImpl: typeof fetch = fetch,
  nowMs: number = Date.now(),
): Promise<CachedAccessToken | null> {
  try {
    const resp = await fetchImpl(GCE_METADATA_TOKEN_URL, {
      method: 'GET',
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(1500),
    })
    if (!resp.ok) return null
    const data = (await resp.json()) as { access_token?: string; expires_in?: number }
    if (typeof data.access_token !== 'string' || !data.access_token.trim()) return null
    const expiresInSec = typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : 3600
    return {
      accessToken: data.access_token.trim(),
      expiresAtMs: nowMs + expiresInSec * 1000,
    }
  } catch {
    return null
  }
}

function validateProjectId(rawProjectId: string | undefined): string {
  const projectId = (rawProjectId ?? '').trim()
  if (!projectId) {
    throw new Error('VERTEX_EU_PROJECT_ID is missing from environment and Service Account JSON')
  }
  if (!PROJECT_ID_RE.test(projectId)) {
    throw new Error(
      `Invalid VERTEX_EU_PROJECT_ID "${projectId}": must be a valid GCP Project ID matching ${PROJECT_ID_RE} (no spaces or extra characters)`,
    )
  }
  return projectId
}

export interface VertexEuAuthResult {
  accessToken: string
  projectId: string
  source: 'env_token' | 'service_account' | 'gce_metadata'
  clientEmail?: string
}

/**
 * Resolves Vertex AI EU OAuth2 credentials and project ID in order:
 * 1. Explicit `VERTEX_EU_ACCESS_TOKEN` override
 * 2. `GOOGLE_APPLICATION_CREDENTIALS` Service Account JSON (cached with 5-minute refresh margin)
 * 3. GCE Metadata Server (cached with 5-minute refresh margin)
 */
export async function resolveVertexEuAuth(params: {
  env: Record<string, string | undefined>
  projectRoot?: string
  fetchImpl?: typeof fetch
  nowMs?: number
}): Promise<VertexEuAuthResult> {
  const fetchImpl = params.fetchImpl ?? fetch
  const nowMs = params.nowMs ?? Date.now()
  const projectRoot = params.projectRoot ?? PROJECT_ROOT

  const envToken = (params.env['VERTEX_EU_ACCESS_TOKEN'] ?? process.env['VERTEX_EU_ACCESS_TOKEN'] ?? '').trim()
  const envProjectId = (params.env['VERTEX_EU_PROJECT_ID'] ?? process.env['VERTEX_EU_PROJECT_ID'] ?? '').trim()
  const gacPath = (
    params.env['GOOGLE_APPLICATION_CREDENTIALS'] ??
    process.env['GOOGLE_APPLICATION_CREDENTIALS'] ??
    ''
  ).trim()

  if (envToken) {
    let saProjectId: string | undefined
    if (!envProjectId && gacPath) {
      saProjectId = loadServiceAccountKey(gacPath, projectRoot).project_id
    }
    return {
      accessToken: envToken,
      projectId: validateProjectId(envProjectId || saProjectId),
      source: 'env_token',
    }
  }

  if (gacPath) {
    const sa = loadServiceAccountKey(gacPath, projectRoot)
    const tokenUri = sa.token_uri || DEFAULT_GOOGLE_TOKEN_URI
    const resolvedCredPath = isAbsolute(gacPath) ? gacPath : resolve(projectRoot, gacPath)
    const cacheKey = `sa:${resolvedCredPath}:${sa.client_email}:${tokenUri}`
    const cached = tokenCache.get(cacheKey)
    if (cached && cached.expiresAtMs - TOKEN_REFRESH_MARGIN_MS > nowMs) {
      return {
        accessToken: cached.accessToken,
        projectId: validateProjectId(envProjectId || sa.project_id),
        source: 'service_account',
        clientEmail: sa.client_email,
      }
    }

    const fresh = await exchangeServiceAccountJwtForToken(sa, fetchImpl, Math.floor(nowMs / 1000))
    tokenCache.set(cacheKey, fresh)
    return {
      accessToken: fresh.accessToken,
      projectId: validateProjectId(envProjectId || sa.project_id),
      source: 'service_account',
      clientEmail: sa.client_email,
    }
  }

  const gceCacheKey = 'gce:default'
  const cachedGce = tokenCache.get(gceCacheKey)
  if (cachedGce && cachedGce.expiresAtMs - TOKEN_REFRESH_MARGIN_MS > nowMs) {
    return {
      accessToken: cachedGce.accessToken,
      projectId: validateProjectId(envProjectId),
      source: 'gce_metadata',
    }
  }

  const gceToken = await fetchGceMetadataToken(fetchImpl, nowMs)
  if (gceToken) {
    tokenCache.set(gceCacheKey, gceToken)
    return {
      accessToken: gceToken.accessToken,
      projectId: validateProjectId(envProjectId),
      source: 'gce_metadata',
    }
  }

  throw new Error(
    'Vertex AI EU authentication failed: set GOOGLE_APPLICATION_CREDENTIALS (Service Account JSON) or VERTEX_EU_ACCESS_TOKEN in .env (GCE Metadata Server unavailable).',
  )
}
