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
import { shopPage, orderHandler } from './shop'
import { respondPage, respondHandler } from './respond'
import { rewriteHandler } from './rewrite'
import { paymentMiddleware, x402ResourceServer } from '@x402/hono'
import { HTTPFacilitatorClient } from '@x402/core/server'
import { ExactEvmScheme } from '@x402/evm/exact/server'

export { AngelDO } from './durable-object'

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

// OAuth 2.1 discovery + endpoints
app.get('/.well-known/oauth-protected-resource', protectedResourceMetadata)
app.get('/.well-known/oauth-authorization-server', authServerMetadata)
app.post('/oauth/register', oauthRegister)
app.get('/oauth/authorize', oauthAuthorizeGet)
app.post('/oauth/authorize', oauthAuthorizePost)
app.post('/oauth/token', oauthToken)

// MCP (Streamable HTTP)
app.post('/mcp', mcpHandler)

// Public shop page + order intake
app.get('/shop', shopPage)
app.post('/api/order', orderHandler)

// Respond / feedback pages
app.get('/respond/:slug', respondPage)
app.post('/api/respond/:slug', respondHandler)

// x402 payment gate for the rewrite API (Base Sepolia testnet, $0.25/request).
// Falls through without payment when X402_WALLET_ADDRESS is not set.
let x402Middleware: ReturnType<typeof paymentMiddleware> | null = null
app.use('/api/rewrite', async (c, next) => {
  const wallet = c.env.X402_WALLET_ADDRESS
  if (!wallet) return next()
  if (!x402Middleware) {
    const facilitator = new HTTPFacilitatorClient({ url: 'https://x402.org/facilitator' })
    const server = new x402ResourceServer(facilitator)
    server.register('eip155:84532', new ExactEvmScheme())
    x402Middleware = paymentMiddleware(
      {
        'POST /api/rewrite': {
          accepts: {
            scheme: 'exact',
            price: '$0.25',
            network: 'eip155:84532',
            payTo: wallet,
          },
          description: 'Rewrite machine-generated text in a human register',
        },
      },
      server,
    )
  }
  return x402Middleware(c, next)
})
app.post('/api/rewrite', rewriteHandler)

export default {
  fetch: app.fetch,
}
