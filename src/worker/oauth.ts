import type { Context } from 'hono'
import type { Env } from './types'

type C = Context<{ Bindings: Env }>

// --- Base64url ---

function b64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function b64urlStr(s: string): string {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function fromB64url(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  return atob(b64 + '='.repeat((4 - b64.length % 4) % 4))
}

function fromB64urlBytes(s: string): Uint8Array {
  const bin = fromB64url(s)
  return Uint8Array.from(bin, c => c.charCodeAt(0))
}

// --- HMAC tokens (self-contained, signed with PIN) ---

async function getKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
  )
}

async function signToken(payload: Record<string, unknown>, secret: string): Promise<string> {
  const data = b64urlStr(JSON.stringify(payload))
  const key = await getKey(secret)
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))
  return data + '.' + b64url(sig)
}

export async function verifyToken(token: string, secret: string): Promise<Record<string, unknown> | null> {
  const dot = token.indexOf('.')
  if (dot < 0) return null
  const data = token.slice(0, dot)
  const sigStr = token.slice(dot + 1)
  const key = await getKey(secret)
  const sigBytes = fromB64urlBytes(sigStr)
  const valid = await crypto.subtle.verify(
    'HMAC', key, new Uint8Array(sigBytes).buffer as ArrayBuffer, new TextEncoder().encode(data),
  )
  if (!valid) return null
  try {
    const payload = JSON.parse(fromB64url(data)) as Record<string, unknown>
    if (typeof payload.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000)) return null
    return payload
  } catch { return null }
}

async function verifyPkce(codeVerifier: string, codeChallenge: string): Promise<boolean> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier))
  return b64url(hash) === codeChallenge
}

// --- Route handlers ---

export function protectedResourceMetadata(c: C) {
  const origin = new URL(c.req.url).origin
  return c.json({ resource: origin, authorization_servers: [origin] })
}

export function authServerMetadata(c: C) {
  const origin = new URL(c.req.url).origin
  return c.json({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  })
}

export async function oauthRegister(c: C) {
  let body: Record<string, unknown> = {}
  try { body = await c.req.json() } catch {}
  return c.json({
    client_id: crypto.randomUUID(),
    client_name: body.client_name || 'MCP Client',
    redirect_uris: body.redirect_uris || [],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }, 201)
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function authorizePage(params: Record<string, string>, error?: string): Response {
  const fields = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join('\n        ')
  const errorHtml = error
    ? `<div style="color:#ef4444;margin-bottom:16px;font-size:0.9rem">${escapeHtml(error)}</div>`
    : ''
  return new Response(`<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Angel — Authorize</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #1e1e2e; color: #cdd6f4;
    display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #313244; border-radius: 16px; padding: 32px; width: 100%; max-width: 360px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.3); }
  h1 { font-size: 1.3rem; margin: 0 0 4px; }
  .sub { color: #a6adc8; font-size: 0.85rem; margin-bottom: 24px; }
  input[type="password"] { width: 100%; padding: 12px 16px; border-radius: 10px; border: 1px solid #45475a;
    background: #1e1e2e; color: #cdd6f4; font-size: 1rem; box-sizing: border-box; margin-bottom: 16px; }
  input[type="password"]:focus { outline: none; border-color: #6366f1; box-shadow: 0 0 0 2px rgba(99,102,241,0.3); }
  button { width: 100%; padding: 12px; border-radius: 10px; border: none; background: #6366f1;
    color: white; font-size: 1rem; font-weight: 600; cursor: pointer; }
  button:hover { filter: brightness(0.9); }
</style>
</head><body>
<div class="card">
  <h1>Angel</h1>
  <div class="sub">Enter your PIN to authorize MCP access</div>
  ${errorHtml}
  <form method="POST">
    ${fields}
    <input type="password" name="pin" placeholder="PIN" autofocus required>
    <button type="submit">Authorize</button>
  </form>
</div>
</body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}

export function oauthAuthorizeGet(c: C) {
  const q = c.req.query()
  return authorizePage({
    client_id: q.client_id || '',
    redirect_uri: q.redirect_uri || '',
    state: q.state || '',
    code_challenge: q.code_challenge || '',
    code_challenge_method: q.code_challenge_method || '',
    scope: q.scope || '',
    response_type: q.response_type || '',
  })
}

export async function oauthAuthorizePost(c: C) {
  const form = await c.req.formData()
  const pin = form.get('pin') as string
  const params: Record<string, string> = {}
  for (const key of ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'response_type']) {
    params[key] = (form.get(key) as string) || ''
  }

  if (pin !== c.env.PIN) {
    return authorizePage(params, 'Invalid PIN')
  }

  const code = await signToken({
    type: 'auth_code',
    client_id: params.client_id,
    redirect_uri: params.redirect_uri,
    code_challenge: params.code_challenge,
    exp: Math.floor(Date.now() / 1000) + 300,
  }, c.env.PIN)

  const redirect = new URL(params.redirect_uri!)
  redirect.searchParams.set('code', code)
  if (params.state) redirect.searchParams.set('state', params.state)
  return c.redirect(redirect.toString())
}

export async function oauthToken(c: C) {
  let body: Record<string, string>
  const ct = c.req.header('content-type') || ''
  if (ct.includes('application/x-www-form-urlencoded')) {
    const form = await c.req.formData()
    body = Object.fromEntries(form.entries()) as Record<string, string>
  } else {
    body = await c.req.json()
  }

  if (body.grant_type === 'authorization_code') {
    const codePayload = await verifyToken(body.code || '', c.env.PIN)
    if (!codePayload || codePayload.type !== 'auth_code')
      return c.json({ error: 'invalid_grant' }, 400)
    if (codePayload.client_id !== body.client_id)
      return c.json({ error: 'invalid_grant' }, 400)
    if (codePayload.redirect_uri !== body.redirect_uri)
      return c.json({ error: 'invalid_grant' }, 400)
    if (body.code_verifier) {
      const valid = await verifyPkce(body.code_verifier, codePayload.code_challenge as string)
      if (!valid) return c.json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400)
    }

    const now = Math.floor(Date.now() / 1000)
    const accessToken = await signToken({ type: 'access', client_id: body.client_id, exp: now + 7 * 86400 }, c.env.PIN)
    const refreshToken = await signToken({ type: 'refresh', client_id: body.client_id, exp: now + 30 * 86400 }, c.env.PIN)
    return c.json({ access_token: accessToken, token_type: 'Bearer', expires_in: 7 * 86400, refresh_token: refreshToken })
  }

  if (body.grant_type === 'refresh_token') {
    const payload = await verifyToken(body.refresh_token || '', c.env.PIN)
    if (!payload || payload.type !== 'refresh')
      return c.json({ error: 'invalid_grant' }, 400)

    const now = Math.floor(Date.now() / 1000)
    const accessToken = await signToken({ type: 'access', client_id: payload.client_id as string, exp: now + 7 * 86400 }, c.env.PIN)
    const refreshToken = await signToken({ type: 'refresh', client_id: payload.client_id as string, exp: now + 30 * 86400 }, c.env.PIN)
    return c.json({ access_token: accessToken, token_type: 'Bearer', expires_in: 7 * 86400, refresh_token: refreshToken })
  }

  return c.json({ error: 'unsupported_grant_type' }, 400)
}
