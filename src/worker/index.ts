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

// CDP JWT auth for the Coinbase x402 facilitator (Ed25519 / EdDSA)
function toBase64Url(buf: Uint8Array): string {
  let s = ''
  for (const b of buf) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function cdpJwt(keyId: string, secret: string, uri: string): Promise<string> {
  const raw = Uint8Array.from(atob(secret), c => c.charCodeAt(0))
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: 'OKP', crv: 'Ed25519', d: toBase64Url(raw.slice(0, 32)), x: toBase64Url(raw.slice(32)) },
    { name: 'Ed25519' },
    false,
    ['sign'],
  )
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('')
  const now = Math.floor(Date.now() / 1000)
  const enc = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const h = enc({ alg: 'EdDSA', typ: 'JWT', kid: keyId, nonce })
  const p = enc({ sub: keyId, iss: 'cdp', aud: ['cdp_service'], nbf: now, exp: now + 120, uris: [uri] })
  const sig = toBase64Url(new Uint8Array(await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(`${h}.${p}`))))
  return `${h}.${p}.${sig}`
}

// x402 payment gate for the rewrite API (Base mainnet, $0.25/request).
// Falls through without payment when X402_WALLET_ADDRESS is not set.
let x402Middleware: ReturnType<typeof paymentMiddleware> | null = null
app.use('/api/rewrite', async (c, next) => {
  const wallet = c.env.X402_WALLET_ADDRESS
  if (!wallet) return next()
  if (!x402Middleware) {
    const { CDP_API_KEY_ID: kid, CDP_API_KEY_SECRET: ksecret } = c.env
    const facilitator = new HTTPFacilitatorClient(
      kid && ksecret
        ? {
            url: 'https://api.cdp.coinbase.com/platform/v2/x402',
            createAuthHeaders: async () => {
              const hdr = async (method: string, path: string) => ({
                Authorization: `Bearer ${await cdpJwt(kid, ksecret, `${method} api.cdp.coinbase.com${path}`)}`,
              })
              return {
                verify: await hdr('POST', '/platform/v2/x402/verify'),
                settle: await hdr('POST', '/platform/v2/x402/settle'),
                supported: await hdr('GET', '/platform/v2/x402/supported'),
              }
            },
          }
        : { url: 'https://x402.org/facilitator' },
    )
    const server = new x402ResourceServer(facilitator)
    const network = kid && ksecret ? 'eip155:8453' : 'eip155:84532'
    server.register(network, new ExactEvmScheme())
    x402Middleware = paymentMiddleware(
      {
        'POST /api/rewrite': {
          accepts: {
            scheme: 'exact',
            price: '$0.25',
            network,
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
