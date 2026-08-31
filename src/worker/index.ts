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
import { ExactEvmScheme as ExactEvmClientScheme, registerExactEvmScheme } from '@x402/evm/exact/client'
import { x402Client } from '@x402/core/client'
import { declareDiscoveryExtension, bazaarResourceServerExtension } from '@x402/extensions/bazaar'

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

// CDP Wallet Auth JWT (ES256 / P-256) — required for wallet signing endpoints
async function cdpWalletJwt(walletSecret: string, method: string, path: string, body?: unknown): Promise<string> {
  const raw = Uint8Array.from(atob(walletSecret), c => c.charCodeAt(0))
  const key = await crypto.subtle.importKey('pkcs8', raw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const uri = `${method} api.cdp.coinbase.com${path}`
  const now = Math.floor(Date.now() / 1000)
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('')
  const claims: Record<string, unknown> = { uris: [uri] }
  if (body && typeof body === 'object' && Object.keys(body as Record<string, unknown>).length > 0) {
    const sorted = JSON.stringify(sortKeysDeep(body as Record<string, unknown>))
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sorted))
    claims.reqHash = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
  }
  const enc = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const h = enc({ alg: 'ES256', typ: 'JWT' })
  const p = enc({ ...claims, iat: now, nbf: now, jti: nonce })
  const sigBuf = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(`${h}.${p}`))
  // ECDSA signature from WebCrypto is raw r||s (64 bytes), which is what jose/JWT expects for ES256
  const sig = toBase64Url(new Uint8Array(sigBuf))
  return `${h}.${p}.${sig}`
}

function sortKeysDeep(obj: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key]
    sorted[key] = v && typeof v === 'object' && !Array.isArray(v) ? sortKeysDeep(v as Record<string, unknown>) : v
  }
  return sorted
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
  return x402Middleware(c, next)
})
app.post('/api/rewrite', rewriteHandler)

// Temporary bootstrap endpoint: signs an x402 payment via CDP-managed wallet
// and calls the rewrite endpoint internally to catalyze the Bazaar listing.
// PIN-protected. Remove after bootstrap is complete.
app.post('/api/bootstrap-bazaar', async (c) => {
  const body = await c.req.json<{ pin?: string }>().catch(() => ({}))
  if (body.pin !== c.env.PIN) return c.json({ error: 'unauthorized' }, 401)

  const wallet = c.env.X402_WALLET_ADDRESS
  if (!wallet) return c.json({ error: 'X402_WALLET_ADDRESS not set' }, 500)

  const { CDP_API_KEY_ID: kid, CDP_API_KEY_SECRET: ksecret, CDP_WALLET_SECRET: wsecret } = c.env
  if (!kid || !ksecret) return c.json({ error: 'CDP keys not configured' }, 500)
  if (!wsecret) return c.json({ error: 'CDP_WALLET_SECRET not configured — set it in CF worker secrets' }, 500)

  try {
    // Discover the buyer address from CDP
    const listPath = '/platform/v2/evm/accounts'
    const listJwt = await cdpJwt(kid, ksecret, `GET api.cdp.coinbase.com${listPath}`)
    const listRes = await fetch(`https://api.cdp.coinbase.com${listPath}`, {
      headers: { 'Authorization': `Bearer ${listJwt}` },
    })
    const listBody = await listRes.json<{ accounts?: Array<{ address: string; name?: string }> }>()
    let buyerAddr: `0x${string}`
    if (listBody.accounts?.length) {
      buyerAddr = listBody.accounts[0].address as `0x${string}`
    } else {
      // Create an EVM account
      const createPath = '/platform/v2/evm/accounts'
      const createBody_ = { name: 'angel-buyer' }
      const createJwt = await cdpJwt(kid, ksecret, `POST api.cdp.coinbase.com${createPath}`)
      const createWalletJwt = await cdpWalletJwt(wsecret, 'POST', createPath, createBody_)
      const createRes = await fetch(`https://api.cdp.coinbase.com${createPath}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${createJwt}`, 'X-Wallet-Auth': createWalletJwt, 'Content-Type': 'application/json' },
        body: JSON.stringify(createBody_),
      })
      const createBody = await createRes.json<{ address?: string; error?: string }>()
      if (!createRes.ok || !createBody.address) {
        return c.json({ error: 'No EVM accounts and could not create one', cdpResponse: createBody, status: createRes.status }, 500)
      }
      buyerAddr = createBody.address as `0x${string}`
    }
    // Step 1: Hit the rewrite endpoint internally to get the 402 response
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

    // Step 2: Build a CDP-backed signer that proxies signTypedData to CDP REST API
    function bigIntReplacer(_k: string, v: unknown): unknown {
      return typeof v === 'bigint' ? v.toString() : v
    }

    const eip712DomainType = (domain: Record<string, unknown>) => {
      const fields: Array<{ name: string; type: string }> = []
      if ('name' in domain) fields.push({ name: 'name', type: 'string' })
      if ('version' in domain) fields.push({ name: 'version', type: 'string' })
      if ('chainId' in domain) fields.push({ name: 'chainId', type: 'uint256' })
      if ('verifyingContract' in domain) fields.push({ name: 'verifyingContract', type: 'address' })
      if ('salt' in domain) fields.push({ name: 'salt', type: 'bytes32' })
      return fields
    }

    const cdpSigner = {
      address: buyerAddr,
      async signTypedData(params: { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> }): Promise<`0x${string}`> {
        const { domain = {}, types, primaryType, message } = params
        const fullTypes = { EIP712Domain: eip712DomainType(domain), ...types }
        const apiBody = JSON.parse(JSON.stringify({ domain, types: fullTypes, primaryType, message }, bigIntReplacer))

        const apiPath = `/platform/v2/evm/accounts/${buyerAddr}/sign/typed-data`
        const jwt = await cdpJwt(kid, ksecret, `POST api.cdp.coinbase.com${apiPath}`)
        const walletJwt = await cdpWalletJwt(wsecret, 'POST', apiPath, apiBody)
        const res = await fetch(`https://api.cdp.coinbase.com${apiPath}`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${jwt}`,
            'X-Wallet-Auth': walletJwt,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(apiBody),
        })
        const resText = await res.text()
        if (!res.ok) throw new Error(`CDP sign: ${res.status} ${resText}`)
        const { signature } = JSON.parse(resText)
        return signature as `0x${string}`
      },
    }

    // Step 3: Use x402 client to create the payment payload
    const client = new x402Client()
    client.setSpendControls(false)
    registerExactEvmScheme(client, { signer: cdpSigner })

    const paymentPayload = await client.createPaymentPayload(paymentRequired)
    const encodedPayment = btoa(JSON.stringify(paymentPayload))

    // Step 4: Make the paid request internally
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
      buyerAddr,
      paymentVersion: paymentPayload.x402Version,
      headerUsed: headerName,
      paymentResponse: paidRes.headers.get('payment-response'),
      body: paidBody,
    })
  } catch (e) {
    return c.json({ error: String(e instanceof Error ? e.message : e), stack: e instanceof Error ? e.stack : undefined }, 500)
  }
})

export default {
  fetch: app.fetch,
}
