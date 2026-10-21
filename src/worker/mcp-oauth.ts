// OAuth for MCP servers, with Angel as the client: find the authorization
// server from the resource's metadata, register with it dynamically, then the
// authorization-code flow with PKCE. Tokens are refreshed before they expire.
// Spec: MCP authorization (2025-06-18), RFC 9728, RFC 8414, RFC 7591.

export interface OAuthState {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  client_id: string
  client_secret?: string
  // How the client proves itself at the token endpoint.
  auth_method: 'none' | 'client_secret_post' | 'client_secret_basic'
  redirect_uri: string
  scope?: string
  access_token?: string
  refresh_token?: string
  expires_at?: number // epoch ms
  pending?: { state: string; verifier: string; created_at: number }
}

export class OAuthError extends Error {}

const TIMEOUT_MS = 20_000

async function getJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json', 'MCP-Protocol-Version': '2025-06-18' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) { await res.body?.cancel(); return null }
    return await res.json() as Record<string, unknown>
  } catch {
    return null
  }
}

// `resource_metadata="..."` and `scope="..."` from a WWW-Authenticate header.
export function parseWwwAuthenticate(header: string | null): { resourceMetadata?: string; scope?: string } {
  if (!header) return {}
  const get = (k: string) => header.match(new RegExp(`${k}="([^"]*)"`))?.[1]
  return { resourceMetadata: get('resource_metadata'), scope: get('scope') }
}

// RFC 8414 puts the issuer's path after the well-known segment; OIDC appends it.
export function metadataUrls(issuer: string): string[] {
  const u = new URL(issuer)
  const path = u.pathname.replace(/\/$/, '')
  if (!path) return [`${u.origin}/.well-known/oauth-authorization-server`, `${u.origin}/.well-known/openid-configuration`]
  return [
    `${u.origin}/.well-known/oauth-authorization-server${path}`,
    `${u.origin}/.well-known/openid-configuration${path}`,
    `${u.origin}${path}/.well-known/openid-configuration`,
  ]
}

interface ServerMeta {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
  scopes?: string
}

async function discover(mcpUrl: string, wwwAuthenticate: string | null): Promise<ServerMeta> {
  const u = new URL(mcpUrl)
  const hint = parseWwwAuthenticate(wwwAuthenticate)
  const path = u.pathname.replace(/\/$/, '')
  const prmUrls = [
    ...(hint.resourceMetadata ? [hint.resourceMetadata] : []),
    ...(path ? [`${u.origin}/.well-known/oauth-protected-resource${path}`] : []),
    `${u.origin}/.well-known/oauth-protected-resource`,
  ]
  let prm: Record<string, unknown> | null = null
  for (const url of prmUrls) if ((prm = await getJson(url))) break

  const servers = (prm?.authorization_servers as string[] | undefined) ?? []
  const issuer = servers[0] || u.origin
  let meta: Record<string, unknown> | null = null
  for (const url of metadataUrls(issuer)) if ((meta = await getJson(url))) break

  const scopes = hint.scope ?? (prm?.scopes_supported as string[] | undefined)?.join(' ')
  if (!meta) {
    // Servers from before the metadata documents: the old default endpoints.
    const base = new URL(issuer).origin
    return { issuer, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, scopes }
  }
  if (typeof meta.authorization_endpoint !== 'string' || typeof meta.token_endpoint !== 'string') {
    throw new OAuthError("The server's sign-in setup is incomplete (no authorization or token endpoint)")
  }
  return {
    issuer: (meta.issuer as string) || issuer,
    authorization_endpoint: meta.authorization_endpoint,
    token_endpoint: meta.token_endpoint,
    registration_endpoint: meta.registration_endpoint as string | undefined,
    scopes,
  }
}

async function register(meta: ServerMeta, redirectUri: string): Promise<Pick<OAuthState, 'client_id' | 'client_secret' | 'auth_method'>> {
  if (!meta.registration_endpoint) {
    throw new OAuthError("This server doesn't let apps register themselves, so Angel can't sign in to it. If it offers an API token, add it with the token instead.")
  }
  const res = await fetch(meta.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'Angel',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(meta.scopes ? { scope: meta.scopes } : {}),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 300)
    throw new OAuthError(`Registering with the server failed (${res.status})${text ? `: ${text}` : ''}`)
  }
  const body = await res.json() as { client_id?: string; client_secret?: string; token_endpoint_auth_method?: string }
  if (!body.client_id) throw new OAuthError('The server registered Angel but sent no client id')
  const method = body.token_endpoint_auth_method
  const auth_method: OAuthState['auth_method'] = !body.client_secret ? 'none'
    : method === 'client_secret_basic' ? 'client_secret_basic' : 'client_secret_post'
  return { client_id: body.client_id, client_secret: body.client_secret, auth_method }
}

// Discover and register: everything up to the point where a person signs in.
export async function prepareOAuth(mcpUrl: string, wwwAuthenticate: string | null, redirectUri: string): Promise<OAuthState> {
  const meta = await discover(mcpUrl, wwwAuthenticate)
  const client = await register(meta, redirectUri)
  return {
    issuer: meta.issuer,
    authorization_endpoint: meta.authorization_endpoint,
    token_endpoint: meta.token_endpoint,
    redirect_uri: redirectUri,
    scope: meta.scopes,
    ...client,
  }
}

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)))
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
}

// A fresh sign-in link. The state and verifier go into `pending` on the returned copy.
export async function authorizationUrl(oauth: OAuthState, mcpUrl: string): Promise<{ url: string; oauth: OAuthState }> {
  const state = randomToken(24)
  const verifier = randomToken(48)
  const u = new URL(oauth.authorization_endpoint)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('client_id', oauth.client_id)
  u.searchParams.set('redirect_uri', oauth.redirect_uri)
  u.searchParams.set('code_challenge', await pkceChallenge(verifier))
  u.searchParams.set('code_challenge_method', 'S256')
  u.searchParams.set('state', state)
  u.searchParams.set('resource', mcpUrl)
  if (oauth.scope) u.searchParams.set('scope', oauth.scope)
  return { url: u.toString(), oauth: { ...oauth, pending: { state, verifier, created_at: Date.now() } } }
}

async function tokenRequest(oauth: OAuthState, params: Record<string, string>): Promise<OAuthState> {
  const body = new URLSearchParams(params)
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }
  if (oauth.auth_method === 'client_secret_basic' && oauth.client_secret) {
    headers.Authorization = `Basic ${btoa(`${encodeURIComponent(oauth.client_id)}:${encodeURIComponent(oauth.client_secret)}`)}`
  } else {
    body.set('client_id', oauth.client_id)
    if (oauth.auth_method === 'client_secret_post' && oauth.client_secret) body.set('client_secret', oauth.client_secret)
  }
  const res = await fetch(oauth.token_endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) })
  const text = await res.text()
  let json: { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string } = {}
  try { json = JSON.parse(text) } catch { /* reported below */ }
  if (!res.ok || !json.access_token) {
    throw new OAuthError(json.error_description || json.error || `The token request failed (${res.status})`)
  }
  return {
    ...oauth,
    access_token: json.access_token,
    // Some servers rotate the refresh token, some keep the old one valid.
    refresh_token: json.refresh_token ?? oauth.refresh_token,
    expires_at: json.expires_in ? Date.now() + json.expires_in * 1000 : undefined,
    pending: undefined,
  }
}

export function exchangeCode(oauth: OAuthState, code: string, mcpUrl: string): Promise<OAuthState> {
  if (!oauth.pending) throw new OAuthError('No sign-in was in progress')
  return tokenRequest(oauth, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: oauth.redirect_uri,
    code_verifier: oauth.pending.verifier,
    resource: mcpUrl,
  })
}

export function refreshAccess(oauth: OAuthState, mcpUrl: string): Promise<OAuthState> {
  if (!oauth.refresh_token) throw new OAuthError('The sign-in expired and there is no way to renew it')
  return tokenRequest(oauth, { grant_type: 'refresh_token', refresh_token: oauth.refresh_token, resource: mcpUrl })
}

// Close enough to expiry that it's worth renewing before use.
export const needsRefresh = (oauth: OAuthState) => !!oauth.expires_at && oauth.expires_at - Date.now() < 60_000
