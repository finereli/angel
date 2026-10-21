// Who is calling, and may they. Sign-in is login.finereli.com (it says who
// someone is); what they may do is ours: the allowed_emails table in D1, managed
// by hand, while every user still runs on the owner's OpenRouter key. Open
// sign-up waits for BYOK.
import type { Env } from './types'
import { verifyLoginToken } from '../../shared/functions/verify-login'
import { normalizeEmail } from './email'

// Tokens are minted for an app's origin; a token for another finereli app is refused.
const DEV_EMAIL = 'dev@localhost'
const AUDIENCE = ['https://angel.finereli.com', 'http://localhost:5173', 'http://localhost:8787']

export interface Caller {
  sub: string
  email: string
  name: string
}

// The browser can't set headers on a WebSocket, so the token rides the
// subprotocol list: ['angel.v1', 'auth.<token>']. The server answers 'angel.v1',
// so the token is never echoed back.
export const WS_PROTOCOL = 'angel.v1'
const WS_TOKEN_PREFIX = 'auth.'

export function tokenOf(request: Request): string | undefined {
  const bearer = request.headers.get('Authorization')?.match(/^Bearer (.+)$/)?.[1]
  if (bearer) return bearer
  const offered = request.headers.get('Sec-WebSocket-Protocol')?.split(',').map(s => s.trim()) ?? []
  return offered.find(p => p.startsWith(WS_TOKEN_PREFIX))?.slice(WS_TOKEN_PREFIX.length)
}

export function offersAngelProtocol(request: Request): boolean {
  return request.headers.get('Sec-WebSocket-Protocol')?.split(',').some(p => p.trim() === WS_PROTOCOL) ?? false
}

const isOwner = (env: Env, email: string) => !!env.OWNER_EMAIL && normalizeEmail(email) === normalizeEmail(env.OWNER_EMAIL)

// The owner is always in; everyone else must be on the list. The list is a handful
// of rows, so it is read and compared in normalized form each time rather than
// trusting how an address was typed into the table.
export async function isAllowed(env: Env, email: string): Promise<boolean> {
  if (env.DEV_AUTH === 'allow' && email === DEV_EMAIL) return true
  if (isOwner(env, email)) return true
  const want = normalizeEmail(email)
  const rows = await env.DB.prepare('SELECT email FROM allowed_emails').all<{ email: string }>()
  return rows.results.some(r => normalizeEmail(r.email) === want)
}

// The owner's Durable Object name. MCP speaks for the owner, who must have signed in once.
export async function ownerSub(env: Env): Promise<string | null> {
  const users = await env.DB.prepare('SELECT sub, email FROM users').all<{ sub: string; email: string }>()
  return users.results.find(u => isOwner(env, u.email))?.sub ?? null
}

export async function identify(env: Env, request: Request): Promise<Caller | null> {
  // Dev bypass, locked twice: a local host AND DEV_AUTH=allow (.dev.vars only,
  // never a deployed secret).
  if (env.DEV_AUTH === 'allow' && new URL(request.url).hostname === 'localhost') {
    return { sub: 'dev-user', email: DEV_EMAIL, name: 'Dev' }
  }
  const token = tokenOf(request)
  if (!token) return null
  const claims = await verifyLoginToken(token, { audience: AUDIENCE })
  if (!claims?.email_verified) return null
  return { sub: claims.sub, email: claims.email, name: claims.name }
}
