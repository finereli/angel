// Who is calling, and may they. Sign-in is login.finereli.com (it says who
// someone is); what they may do is ours: ALLOWED_EMAILS, while every user still
// runs on the owner's OpenRouter key. Open sign-up waits for BYOK.
import type { Env } from './types'
import { verifyLoginToken } from '../../shared/functions/verify-login'

// Tokens are minted for an app's origin; a token for another finereli app is refused.
const AUDIENCE = ['https://angel.finereli.com', 'http://localhost:5173', 'http://localhost:8787']

export interface Caller {
  sub: string
  email: string
  name: string
  owner: boolean
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

const isOwner = (env: Env, email: string) => !!env.OWNER_EMAIL && email.toLowerCase() === env.OWNER_EMAIL.toLowerCase()

export function isAllowed(env: Env, email: string): boolean {
  const list = (env.ALLOWED_EMAILS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  return isOwner(env, email) || list.includes(email.toLowerCase())
}

export async function identify(env: Env, request: Request): Promise<Caller | null> {
  // Dev bypass, locked twice: a local host AND DEV_AUTH=allow (.dev.vars only,
  // never a deployed secret).
  if (env.DEV_AUTH === 'allow' && new URL(request.url).hostname === 'localhost') {
    return { sub: 'dev-user', email: 'dev@localhost', name: 'Dev', owner: isOwner(env, 'dev@localhost') }
  }
  const token = tokenOf(request)
  if (!token) return null
  const claims = await verifyLoginToken(token, { audience: AUDIENCE })
  if (!claims?.email_verified) return null
  return { sub: claims.sub, email: claims.email, name: claims.name, owner: isOwner(env, claims.email) }
}
