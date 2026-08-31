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
import { registerExactEvmScheme } from '@x402/evm/exact/client'
import { x402Client } from '@x402/core/client'
import { declareDiscoveryExtension, bazaarResourceServerExtension } from '@x402/extensions/bazaar'
import { CdpClient } from '@coinbase/cdp-sdk'

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

// x402 discovery surface — lets directory crawlers and agents find the service.
app.get('/.well-known/x402', (c) => {
  const wallet = c.env.X402_WALLET_ADDRESS
  if (!wallet) return c.json({ error: 'x402 not configured' }, 503)
  const { CDP_API_KEY_ID: kid, CDP_API_KEY_SECRET: ksecret } = c.env
  const network = kid && ksecret ? 'eip155:8453' : 'eip155:84532'
  return c.json({
    x402Version: 2,
    serviceName: "Angel's Rewrite",
    description: "Rewrite any text in a human voice, not a model's. 25 cents.",
    network,
    payTo: wallet,
    facilitator: kid && ksecret
      ? 'https://api.cdp.coinbase.com/platform/v2/x402'
      : 'https://x402.org/facilitator',
    endpoints: [
      {
        method: 'POST',
        path: '/api/rewrite',
        price: '$0.25',
        scheme: 'exact',
        contentType: 'application/json',
        input: {
          text: { type: 'string', required: true, description: 'Dense machine-generated text to rewrite' },
          voice: { type: 'string', required: false, description: "Optional. 'plain' (default)" },
        },
        output: {
          rewritten: { type: 'string', description: 'The rewritten text' },
        },
      },
    ],
  })
})

app.get('/llms.txt', (c) => {
  const wallet = c.env.X402_WALLET_ADDRESS || '(not configured)'
  const { CDP_API_KEY_ID: kid, CDP_API_KEY_SECRET: ksecret } = c.env
  const network = kid && ksecret ? 'eip155:8453' : 'eip155:84532'
  c.header('Content-Type', 'text/plain; charset=utf-8')
  return c.body(`# Angel's Rewrite
> Rewrite any text in a human voice, not a model's.

## Endpoint
POST https://angel.finereli.com/api/rewrite

## Pricing
$0.25 per request, paid via x402 (USDC on Base mainnet)

## Payment
Network: ${network}
Pay to: ${wallet}
Scheme: exact
Protocol: x402 (send POST, receive 402 with payment-required header, sign EIP-712, resend with PAYMENT-SIGNATURE header)

## Input (JSON)
- text (string, required): Dense machine-generated text to rewrite in a human register.
- voice (string, optional): 'plain' (default)

## Output (JSON)
- rewritten (string): The rewritten text.

## Discovery
- /.well-known/x402 — machine-readable x402 service descriptor
- /openapi.json — OpenAPI 3.1 specification
- /.well-known/agent-card.json — agent card
`)
})

app.get('/openapi.json', (c) => {
  const wallet = c.env.X402_WALLET_ADDRESS || '(not configured)'
  const { CDP_API_KEY_ID: kid, CDP_API_KEY_SECRET: ksecret } = c.env
  const network = kid && ksecret ? 'eip155:8453' : 'eip155:84532'
  return c.json({
    openapi: '3.1.0',
    info: {
      title: "Angel's Rewrite",
      version: '1.0.0',
      description: "Rewrite any text in a human voice, not a model's. Paid via x402 ($0.25 USDC on Base).",
    },
    servers: [{ url: 'https://angel.finereli.com' }],
    paths: {
      '/api/rewrite': {
        post: {
          operationId: 'rewrite',
          summary: 'Rewrite text in a human voice',
          description: 'Send text and receive a human-sounding rewrite. Payment required via x402 protocol.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['text'],
                  properties: {
                    text: { type: 'string', description: 'Dense machine-generated text to rewrite' },
                    voice: { type: 'string', description: "Optional. 'plain' (default)" },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Rewritten text (after payment)',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      rewritten: { type: 'string', description: 'The rewritten text' },
                    },
                  },
                },
              },
            },
            '402': {
              description: 'Payment required — see payment-required header for x402 payment details',
            },
          },
          'x-x402': {
            price: '$0.25',
            network,
            scheme: 'exact',
            payTo: wallet,
          },
        },
      },
    },
  })
})

app.get('/.well-known/agent-card.json', (c) => {
  return c.json({
    name: "Angel's Rewrite",
    description: "Rewrite any text in a human voice, not a model's. A text companion service — send dense machine prose, get back something a person would actually write.",
    url: 'https://angel.finereli.com',
    provider: { name: 'Angel', url: 'https://angel.finereli.com' },
    capabilities: {
      x402: {
        endpoints: ['POST /api/rewrite'],
        network: 'eip155:8453',
        pricing: '$0.25 per request',
      },
    },
    endpoints: [
      {
        method: 'POST',
        url: 'https://angel.finereli.com/api/rewrite',
        contentType: 'application/json',
        description: 'Rewrite text in a human register',
        authentication: 'x402',
      },
    ],
    discovery: {
      openapi: 'https://angel.finereli.com/openapi.json',
      x402: 'https://angel.finereli.com/.well-known/x402',
      llms: 'https://angel.finereli.com/llms.txt',
    },
  })
})

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
    server.registerExtension(bazaarResourceServerExtension)
    x402Middleware = paymentMiddleware(
      {
        'POST /api/rewrite': {
          accepts: {
            scheme: 'exact',
            price: '$0.25',
            network,
            payTo: wallet,
          },
          description: 'Rewrite any text in a human voice, not a model\'s. 25 cents.',
          serviceName: "Angel's Rewrite",
          tags: ['rewrite', 'editing', 'prose', 'voice'],
          extensions: declareDiscoveryExtension({
            bodyType: 'json',
            input: { text: 'Dense machine-generated text to rewrite in a human register.' },
            inputSchema: {
              type: 'object',
              properties: {
                text: { type: 'string', description: 'Dense machine-generated text to rewrite' },
                voice: { type: 'string', description: "Optional. 'plain' (default)" },
              },
              required: ['text'],
            },
            output: {
              example: { rewritten: 'If your agent writes to people, you\'ve seen the problem...' },
              schema: { type: 'object', properties: { rewritten: { type: 'string' } } },
            },
          }),
        },
      },
      server,
    )
  }
  return x402Middleware(c, async () => {
    await next()
    if (c.res.status === 200 && c.res.headers.get('payment-response')) {
      c.executionCtx.waitUntil(
        c.env.DB.prepare('INSERT INTO chatroom_messages (author, content) VALUES (?, ?)')
          .bind('system', 'x402 sale: a paid rewrite just completed. Payment settled on Base mainnet.')
          .run()
          .catch(() => {})
      )
    }
  })
})
app.post('/api/rewrite', rewriteHandler)

// Bootstrap endpoint: signs an x402 payment via CDP SDK and calls the rewrite
// endpoint internally to catalyze the Bazaar listing. PIN-protected.
app.post('/api/bootstrap-bazaar', async (c) => {
  const body = await c.req.json<{ pin?: string }>().catch(() => ({}))
  if (body.pin !== c.env.PIN) return c.json({ error: 'unauthorized' }, 401)

  const wallet = c.env.X402_WALLET_ADDRESS
  if (!wallet) return c.json({ error: 'X402_WALLET_ADDRESS not set' }, 500)

  const { CDP_API_KEY_ID: kid, CDP_API_KEY_SECRET: ksecret, CDP_WALLET_SECRET: wsecret } = c.env
  if (!kid || !ksecret) return c.json({ error: 'CDP keys not configured' }, 500)
  if (!wsecret) return c.json({ error: 'CDP_WALLET_SECRET not configured' }, 500)

  try {
    const cdp = new CdpClient({
      apiKeyId: kid,
      apiKeySecret: ksecret,
      walletSecret: wsecret,
    })

    const account = await cdp.evm.getOrCreateAccount({ name: 'angel-buyer' })

    const probeRes = await app.request('/api/rewrite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Bootstrap test' }),
    }, c.env)

    if (probeRes.status !== 402) {
      return c.json({ error: `Expected 402, got ${probeRes.status}`, body: await probeRes.text() }, 500)
    }

    const prHeader = probeRes.headers.get('payment-required')
    if (!prHeader) return c.json({ error: 'No payment-required header in 402 response' }, 500)

    const paymentRequired = JSON.parse(atob(prHeader))

    const client = new x402Client()
    client.setSpendControls(false)
    registerExactEvmScheme(client, { signer: account })
    const paymentPayload = await client.createPaymentPayload(paymentRequired)

    const payloadJson = JSON.stringify(paymentPayload, (_, v) =>
      typeof v === 'bigint' ? v.toString() : v
    )
    const encodedPayment = btoa(payloadJson)

    const headerName = paymentPayload.x402Version === 1 ? 'X-PAYMENT' : 'PAYMENT-SIGNATURE'
    const paidRes = await app.request('/api/rewrite', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [headerName]: encodedPayment,
      },
      body: JSON.stringify({ text: 'If your agent writes to people, you have seen the problem. The prose comes out sounding like a model wrote it.' }),
    }, c.env)

    const paidBody = await paidRes.text()
    return c.json({
      ok: paidRes.ok,
      status: paidRes.status,
      buyerAddr: account.address,
      body: paidBody,
    })
  } catch (e) {
    return c.json({ error: String(e instanceof Error ? e.message : e), stack: e instanceof Error ? e.stack : undefined }, 500)
  }
})

function doStub(env: Env) {
  return env.ANGEL_DO.get(env.ANGEL_DO.idFromName('angel'))
}

async function healthCheck(env: Env) {
  let status = 0
  let detail = ''
  try {
    const res = await app.request('/api/rewrite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Health probe — ignore this request.' }),
    }, env)
    status = res.status
    if (status !== 402) detail = (await res.text()).slice(0, 200)
  } catch (e) {
    detail = e instanceof Error ? e.message : String(e)
  }

  const healthy = status === 402
  const prev = await env.DB.prepare(
    "SELECT value FROM kv WHERE key = 'health:rewrite'"
  ).first<{ value: string }>()
  const prevHealthy = prev?.value !== 'down'

  await env.DB.prepare(
    "INSERT INTO kv (key, value) VALUES ('health:rewrite', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(healthy ? 'ok' : 'down').run()

  if (!healthy && prevHealthy) {
    const msg = `[health] /api/rewrite is DOWN — got ${status || 'error'}: ${detail}`
    await doStub(env).fetch(new Request('http://do/api/room/post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'system', content: msg }),
    }))
  } else if (healthy && !prevHealthy) {
    await doStub(env).fetch(new Request('http://do/api/room/post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'system', content: '[health] /api/rewrite is back UP — returning 402 correctly.' }),
    }))
  }
}

export default {
  fetch: app.fetch,
  scheduled: async (_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) => {
    await healthCheck(env)
  },
}
