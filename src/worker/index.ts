import { Hono } from 'hono'
import type { Env } from './types'
import {
  protectedResourceMetadata,
  authServerMetadata,
  oauthRegister,
  oauthAuthorizeGet,
  oauthAuthorizePost,
  oauthToken,
} from './oauth'
import { mcpHandler } from './mcp'
import { identify, isAllowed, offersAngelProtocol, type Caller } from './access'

export { AngelDO } from './durable-object'

type AppContext = { Bindings: Env }
const app = new Hono<AppContext>()

const userStub = (env: Env, sub: string) => env.ANGEL_DO.get(env.ANGEL_DO.idFromName(sub))

// Remember who signed in. The cron walks this table to re-arm every user's alarm.
async function noteUser(env: Env, who: Caller) {
  await env.DB.prepare(
    `INSERT INTO users (sub, email, name) VALUES (?, ?, ?)
     ON CONFLICT(sub) DO UPDATE SET email = excluded.email, name = excluded.name, last_seen = datetime('now')`
  ).bind(who.sub, who.email, who.name).run()
}

// Who am I: the client's probe after a failed connect, to tell a dead sign-in
// (401: sign in again) from a signed-in account that isn't allowed (403).
app.get('/api/me', async (c) => {
  const who = await identify(c.env, c.req.raw)
  if (!who) return c.json({ error: 'unauthorized' }, 401)
  if (!isAllowed(c.env, who.email)) return c.json({ error: 'not_allowed', email: who.email }, 403)
  return c.json({ email: who.email, name: who.name })
})

// WebSocket upgrade: verify the login token here, then hand the socket to that
// user's own Durable Object. The DO trusts X-Angel-* because only this route sets them.
app.get('/ws', async (c) => {
  const who = await identify(c.env, c.req.raw)
  if (!who) return c.text('Unauthorized', 401)
  if (!isAllowed(c.env, who.email)) return c.text('Not allowed', 403)
  await noteUser(c.env, who)
  const headers = new Headers(c.req.raw.headers)
  headers.set('X-Angel-Sub', who.sub)
  if (!offersAngelProtocol(c.req.raw)) headers.delete('Sec-WebSocket-Protocol')
  return userStub(c.env, who.sub).fetch(new Request(c.req.raw, { headers }))
})

// Health check (no auth)
app.get('/api/health', (c) => c.json({ ok: true, name: 'Angel' }))
app.get('/health', (c) => c.json({ ok: true, name: 'Angel' }))

// The SPA. Everything that isn't a worker route falls through to the assets.
const serveApp = async (c: { req: { url: string }; env: Env }) => {
  const url = new URL(c.req.url)
  url.pathname = '/index.html'
  return c.env.ASSETS.fetch(url.toString())
}
app.get('/', serveApp)
app.get('/chat', serveApp)

// OAuth 2.1 discovery + endpoints
app.get('/.well-known/oauth-protected-resource', protectedResourceMetadata)
app.get('/.well-known/oauth-authorization-server', authServerMetadata)
app.post('/oauth/register', oauthRegister)
app.get('/oauth/authorize', oauthAuthorizeGet)
app.post('/oauth/authorize', oauthAuthorizePost)
app.post('/oauth/token', oauthToken)

// MCP (Streamable HTTP)
app.post('/mcp', mcpHandler)

export default {
  fetch: app.fetch,
  // Each user's DO owns its wake-up alarm; the cron is a safety net that re-arms
  // any alarm lost to an eviction.
  scheduled: async (_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) => {
    const users = await env.DB.prepare(`SELECT sub FROM users`).all<{ sub: string }>()
    await Promise.all(users.results.map(u =>
      userStub(env, u.sub)
        .fetch(new Request('http://do/api/sync-alarm', { method: 'POST' }))
        .catch(() => {})
    ))
  },
}
