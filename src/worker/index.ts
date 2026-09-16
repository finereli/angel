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

export { AngelDO } from './durable-object'
// The workspace container's Durable Object class (see worker/sandbox.ts).
export { Sandbox } from '@cloudflare/sandbox'

type AppContext = { Bindings: Env }
const app = new Hono<AppContext>()

// WebSocket upgrade → Durable Object
app.get('/ws', async (c) => {
  const id = c.env.ANGEL_DO.idFromName('angel')
  const stub = c.env.ANGEL_DO.get(id)
  return stub.fetch(c.req.raw)
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

function doStub(env: Env) {
  return env.ANGEL_DO.get(env.ANGEL_DO.idFromName('angel'))
}

export default {
  fetch: app.fetch,
  // The DO owns the wake-up alarm; the cron is a safety net that re-arms it if
  // the DO was evicted with no alarm pending.
  scheduled: async (_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) => {
    await doStub(env)
      .fetch(new Request('http://do/api/sync-alarm', { method: 'POST' }))
      .catch(() => {})
  },
}
