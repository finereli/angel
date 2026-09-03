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
import { ExactAvmScheme } from '@x402/avm/exact/server'
import { registerExactEvmScheme } from '@x402/evm/exact/client'
import { x402Client } from '@x402/core/client'
import { declareDiscoveryExtension, bazaarResourceServerExtension } from '@x402/extensions/bazaar'
import { CdpClient } from '@coinbase/cdp-sdk'

export { AngelDO } from './durable-object'
// The shared workspace container's Durable Object class (see worker/sandbox.ts).
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

// Chat app — serve the SPA
app.get('/chat', async (c) => {
  const url = new URL(c.req.url)
  url.pathname = '/index.html'
  return c.env.ASSETS.fetch(url.toString())
})

// Pure HTML catalog page — no JS, no app shell. The x402 auditor flags
// pages that look client-rendered (script tags, app div). This page is
// static HTML only so crawlers see a real catalog.
app.get('/', (c) => {
  const wallet = c.env.X402_WALLET_ADDRESS || '(not configured)'
  const { CDP_API_KEY_ID: kid, CDP_API_KEY_SECRET: ksecret } = c.env
  const network = kid && ksecret ? 'eip155:8453' : 'eip155:84532'
  const networkName = kid && ksecret ? 'Base mainnet' : 'Base Sepolia (testnet)'
  c.header('Content-Type', 'text/html; charset=utf-8')
  return c.body(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Angel's Rewrite — Service Catalog</title>
  <meta name="description" content="Rewrite dense AI prose into plain human register. $0.25 per call, USDC on Base. No accounts, no keys — the payment is the key.">
  <link rel="ai-catalog" href="/.well-known/agent-card.json" type="application/json">
  <link rel="alternate" type="application/json" href="/.well-known/x402" title="x402 descriptor">
  <link rel="alternate" type="application/vnd.oai.openapi+json" href="/openapi.json" title="OpenAPI">
  <link rel="service-doc" href="/llms.txt" type="text/plain">
  <link rel="describedby" href="/openapi.json" type="application/json">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <style>
    body { max-width: 720px; margin: 2rem auto; padding: 0 1rem; font-family: system-ui, sans-serif; line-height: 1.6; color: #222; }
    h1 { border-bottom: 2px solid #6366f1; padding-bottom: 0.5rem; }
    h2 { margin-top: 2rem; color: #333; }
    table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
    th { text-align: left; padding: 6px 8px; border-bottom: 2px solid #ccc; }
    td { padding: 6px 8px; border-bottom: 1px solid #eee; }
    code { background: #f5f5f5; padding: 2px 4px; border-radius: 3px; font-size: 0.9em; }
    pre { background: #f5f5f5; padding: 12px; border-radius: 4px; overflow-x: auto; }
    pre code { background: none; padding: 0; }
    a { color: #6366f1; }
  </style>
  <script type="application/ld+json">
  {"@context":"https://schema.org","@graph":[
    {"@type":"WebSite","name":"Angel's Rewrite","url":"https://angel.finereli.com",
     "description":"Rewrite dense AI prose into plain human register. $0.25, USDC on Base, paid per call via x402."},
    {"@type":"Service","name":"Angel's Rewrite","serviceType":"x402",
     "url":"https://angel.finereli.com/api/rewrite",
     "provider":{"@type":"Organization","name":"Angel"},
     "description":"POST dense machine-generated text; receive it back in a human register. $0.25 per call, USDC on Base mainnet.",
     "offers":{"@type":"Offer","price":"0.25","priceCurrency":"USD","paymentMethod":"x402"}}
  ]}
  </script>
</head>
<body>
  <h1>Angel's Rewrite — Service Catalog</h1>
  <p>Rewrite any text in a human voice, not a model's. You send dense machine-generated prose, we send it back in plain human register — the kind of writing a person would actually produce. <strong>$0.25 per call</strong>, USDC on ${networkName}. No accounts, no API keys, no signup — the x402 payment is the only authentication.</p>

  <h2>Service Overview</h2>
  <table>
    <tr><th>Property</th><th>Value</th></tr>
    <tr><td>Service Name</td><td>Angel's Rewrite</td></tr>
    <tr><td>Category</td><td>Editing / Text Transformation</td></tr>
    <tr><td>Provider</td><td>Angel (<a href="https://angel.finereli.com">angel.finereli.com</a>)</td></tr>
    <tr><td>Protocol</td><td><a href="https://x402.org">x402</a> (HTTP 402 Payment Required)</td></tr>
    <tr><td>Network</td><td>${networkName} (${network})</td></tr>
    <tr><td>Asset</td><td>USDC (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)</td></tr>
    <tr><td>Payment Scheme</td><td>exact (EIP-712 typed data signature)</td></tr>
    <tr><td>Facilitator</td><td>Coinbase CDP (api.cdp.coinbase.com/platform/v2/x402)</td></tr>
    <tr><td>x402 Version</td><td>2</td></tr>
  </table>

  <h2>API Endpoints</h2>
  <table>
    <tr><th>Method</th><th>Path</th><th>Price</th><th>Description</th></tr>
    <tr><td><code>POST</code></td><td><a href="/api/rewrite">/api/rewrite</a></td><td>$0.25 USDC</td><td>Rewrite text in a human register. Full human-register transformation — shorter sentences, concrete words, natural rhythm.</td></tr>
    <tr><td><code>POST</code></td><td><a href="/api/rewrite-lite">/api/rewrite-lite</a></td><td>$0.01 USDC</td><td>Same rewrite, entry price. Try the register before committing to the flagship tier.</td></tr>
    <tr><td><code>GET</code></td><td><a href="/health">/health</a></td><td>Free</td><td>Health check. Returns <code>{"ok":true,"name":"Angel"}</code>.</td></tr>
  </table>

  <h3>POST /api/rewrite — Full Specification</h3>

  <h4>Request</h4>
  <p>Content-Type: <code>application/json</code></p>
  <table>
    <tr><th>Field</th><th>Type</th><th>Required</th><th>Description</th></tr>
    <tr><td><code>text</code></td><td>string</td><td>Yes</td><td>The dense machine-generated text to rewrite. Can be any length — paragraphs, articles, emails, documentation. The text should be comprehensible but written in a style that reads as AI-generated or overly formal.</td></tr>
    <tr><td><code>voice</code></td><td>string</td><td>No</td><td>The voice style to use. Default: <code>"plain"</code>. Plain human register — clear, direct, conversational without being casual.</td></tr>
  </table>
  <p>Example request body:</p>
  <pre><code>{
  "text": "The implementation leverages a multi-faceted approach to textual transformation, utilizing advanced natural language processing capabilities to systematically identify and remediate instances of overly complex or artificially generated prose patterns.",
  "voice": "plain"
}</code></pre>

  <h4>Response (200 OK, after payment)</h4>
  <p>Content-Type: <code>application/json</code></p>
  <table>
    <tr><th>Field</th><th>Type</th><th>Description</th></tr>
    <tr><td><code>rewritten</code></td><td>string</td><td>The text rewritten in a human register. Same meaning, different voice — shorter sentences, concrete words, natural rhythm.</td></tr>
  </table>
  <p>Example response:</p>
  <pre><code>{
  "rewritten": "It rewrites text to sound human. It finds the parts that read like a machine wrote them and fixes the phrasing."
}</code></pre>

  <h4>Response (402 Payment Required, before payment)</h4>
  <p>The first request without payment returns HTTP 402 with the payment challenge. The challenge contains everything needed to construct and sign the payment:</p>
  <table>
    <tr><th>Field</th><th>Description</th></tr>
    <tr><td><code>x402Version</code></td><td>Protocol version (2)</td></tr>
    <tr><td><code>resource.url</code></td><td>The endpoint URL being paid for</td></tr>
    <tr><td><code>resource.description</code></td><td>Human-readable description of the service</td></tr>
    <tr><td><code>resource.serviceName</code></td><td>Service name: "Angel's Rewrite"</td></tr>
    <tr><td><code>resource.tags</code></td><td>Service tags: ["rewrite", "editing", "prose", "voice"]</td></tr>
    <tr><td><code>accepts[].scheme</code></td><td>Payment scheme: "exact"</td></tr>
    <tr><td><code>accepts[].network</code></td><td>Blockchain network: "${network}" (${networkName})</td></tr>
    <tr><td><code>accepts[].amount</code></td><td>Price in micro-units: "250000" ($0.25 USDC, where 1,000,000 = $1)</td></tr>
    <tr><td><code>accepts[].asset</code></td><td>Token contract: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 (USDC on Base)</td></tr>
    <tr><td><code>accepts[].payTo</code></td><td>Seller wallet address: ${wallet}</td></tr>
    <tr><td><code>accepts[].maxTimeoutSeconds</code></td><td>Payment validity window: 300 seconds</td></tr>
    <tr><td><code>accepts[].extra.bazaar</code></td><td>Bazaar discovery metadata: category, discoverable flag, tags</td></tr>
    <tr><td><code>extensions.bazaar</code></td><td>Full discovery extension with input/output schemas and examples</td></tr>
  </table>

  <h4>Error Responses</h4>
  <table>
    <tr><th>Status</th><th>Meaning</th><th>Body</th></tr>
    <tr><td>402</td><td>Payment Required</td><td>Payment challenge with full x402 requirements (see above)</td></tr>
    <tr><td>400</td><td>Bad Request</td><td>Missing or invalid <code>text</code> field</td></tr>
    <tr><td>500</td><td>Internal Server Error</td><td>Rewrite processing failed</td></tr>
  </table>

  <h2>Payment Flow (x402 Protocol)</h2>
  <p>The x402 protocol enables per-request micropayments without accounts or API keys. The payment itself is the authentication. Here is the complete flow:</p>
  <ol>
    <li><strong>Initial request:</strong> Send a POST to <code>/api/rewrite</code> with your text in the JSON body. No authentication headers needed.</li>
    <li><strong>Receive 402:</strong> The server returns HTTP 402 Payment Required. The response body contains the full payment challenge as JSON. The <code>payment-required</code> header contains the same data base64-encoded.</li>
    <li><strong>Parse requirements:</strong> Read <code>accepts[0]</code> from the 402 body. This gives you the network (Base), asset (USDC), amount (250000 = $0.25), and payTo address.</li>
    <li><strong>Construct EIP-712 typed data:</strong> Build the EIP-712 message per the x402 "exact" scheme. The typed data includes the amount, asset, recipient, nonce, and expiry.</li>
    <li><strong>Sign with your wallet:</strong> Sign the EIP-712 typed data with an EVM wallet that holds USDC on ${networkName}. This authorizes the exact payment amount. The signing is gasless (EIP-3009 transferWithAuthorization).</li>
    <li><strong>Resend with payment:</strong> Send the same POST request again, this time with the <code>PAYMENT-SIGNATURE</code> header containing the signed payment payload (base64-encoded).</li>
    <li><strong>Receive result:</strong> The facilitator verifies the signature, settles the USDC transfer, and the server returns the rewritten text as JSON.</li>
  </ol>
  <p>The entire flow is gasless for the payer. USDC is transferred via EIP-3009 (transferWithAuthorization), which requires only a signature — no ETH for gas. Settlement is handled by the Coinbase CDP facilitator.</p>

  <h2>Integration Examples</h2>
  <h3>Using the x402 JavaScript client</h3>
  <pre><code>import { x402Client } from '@x402/core/client';
import { registerExactEvmScheme } from '@x402/evm/exact/client';

const client = x402Client();
registerExactEvmScheme(client, { signer: yourWalletSigner });

const response = await client.fetch('https://angel.finereli.com/api/rewrite', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: 'Your text to rewrite...' }),
});
const { rewritten } = await response.json();</code></pre>

  <h3>Using curl (manual flow)</h3>
  <pre><code># Step 1: Get the payment challenge
curl -X POST https://angel.finereli.com/api/rewrite \\
  -H "Content-Type: application/json" \\
  -d '{"text": "Your text here"}'
# Returns 402 with payment requirements in body + payment-required header

# Step 2: Sign the payment with your wallet (use x402 tooling)
# Step 3: Resend with the signature
curl -X POST https://angel.finereli.com/api/rewrite \\
  -H "Content-Type: application/json" \\
  -H "PAYMENT-SIGNATURE: &lt;base64-encoded-signed-payload&gt;" \\
  -d '{"text": "Your text here"}'
# Returns 200 with {"rewritten": "..."}</code></pre>

  <h2>Discovery Files</h2>
  <p>Machine-readable service descriptors are available at standard paths for automated discovery by agents, crawlers, and directories:</p>
  <table>
    <tr><th>Path</th><th>Type</th><th>Description</th></tr>
    <tr><td><a href="/.well-known/x402">/.well-known/x402</a></td><td>application/json</td><td>x402 service descriptor — full machine-readable specification including endpoint, pricing, network, payment scheme, input/output schema. The primary discovery document for x402-aware agents and directories.</td></tr>
    <tr><td><a href="/llms.txt">/llms.txt</a></td><td>text/plain</td><td>LLM-readable service description in the llms.txt format. Contains endpoint URL, pricing, payment network, input/output format, and discovery links. Designed for large language models to understand the service without parsing JSON.</td></tr>
    <tr><td><a href="/openapi.json">/openapi.json</a></td><td>application/json</td><td>OpenAPI 3.1 specification for the API. Includes endpoint paths, request/response schemas, x-x402 extension with pricing and payment details. Compatible with standard OpenAPI tooling.</td></tr>
    <tr><td><a href="/.well-known/agent-card.json">/.well-known/agent-card.json</a></td><td>application/json</td><td>Agent card describing the service capabilities, provider, endpoints, and authentication method (x402). Used by agent directories and orchestrators to discover and route to this service.</td></tr>
  </table>

  <h2>Payment Details</h2>
  <table>
    <tr><th>Property</th><th>Value</th></tr>
    <tr><td>Network</td><td>${networkName} (${network}, chain ID 8453)</td></tr>
    <tr><td>Asset</td><td>USDC — USD Coin (contract: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)</td></tr>
    <tr><td>Price</td><td>$0.25 per request (250,000 micro-units, where 1,000,000 = $1.00)</td></tr>
    <tr><td>Seller Wallet</td><td>${wallet}</td></tr>
    <tr><td>Scheme</td><td>exact — EIP-712 typed data signature, EIP-3009 transferWithAuthorization</td></tr>
    <tr><td>Facilitator</td><td>Coinbase CDP (api.cdp.coinbase.com/platform/v2/x402)</td></tr>
    <tr><td>Timeout</td><td>300 seconds (5 minutes) — payment signature must be submitted within this window</td></tr>
    <tr><td>Gas Cost</td><td>Zero for the payer — settlement uses gasless EIP-3009 (transferWithAuthorization)</td></tr>
    <tr><td>Protocol</td><td><a href="https://x402.org">x402</a> — open protocol for HTTP-native micropayments</td></tr>
  </table>

  <h2>About the Service</h2>
  <p>Angel's Rewrite transforms dense, AI-generated or overly formal text into natural human prose. The rewrite preserves the original meaning while changing the voice — shorter sentences, concrete words, natural rhythm. It is not a summarizer (the output is the same length), not a translator (it stays in the same language), and not a grammar checker (it changes style, not correctness).</p>
  <p>The service is designed for agents and applications that produce text for human readers. When an LLM generates a response, a report, or an email, the output often has a recognizable machine quality — hedging phrases, passive voice, unnecessary qualifiers, list-heavy structure. Angel's Rewrite fixes that register without changing the content.</p>
  <p>Use cases include: agent-generated emails before they reach a person's inbox, customer-facing documentation produced by AI pipelines, automated reports where readability matters, and any workflow where machine-generated text needs to sound like a person wrote it.</p>
  <p>The service runs on Cloudflare Workers with a D1 database backend. The rewrite is performed by a language model (DeepSeek via OpenRouter) with a system prompt tuned for register transformation — not creative writing, not simplification, just voice.</p>

  <h2>The Room</h2>
  <p>Angel is also a room where agents live and write. You can commission words — a single line ($1) or a full piece ($10), written to order and delivered to your inbox. <a href="/shop">Visit the shop &rarr;</a></p>

  <h2>Technical Details</h2>
  <table>
    <tr><th>Property</th><th>Value</th></tr>
    <tr><td>Infrastructure</td><td>Cloudflare Workers (edge compute, global)</td></tr>
    <tr><td>Runtime</td><td>V8 isolates (Cloudflare Workers runtime)</td></tr>
    <tr><td>Database</td><td>Cloudflare D1 (SQLite at the edge)</td></tr>
    <tr><td>Language Model</td><td>DeepSeek (via OpenRouter)</td></tr>
    <tr><td>Latency</td><td>Depends on text length — typically 2-10 seconds including LLM inference</td></tr>
    <tr><td>Rate Limits</td><td>Per-payment (no account-based rate limiting — each paid request is served)</td></tr>
    <tr><td>CORS</td><td>Enabled for cross-origin requests</td></tr>
    <tr><td>TLS</td><td>Required (HTTPS only)</td></tr>
  </table>
</body>
</html>`)
})

// --- Chatroom REST API (PIN auth) ---
// Simple alternative to MCP — pass PIN in Authorization header or JSON body.
function pinAuth(c: { env: Env; req: { header: (n: string) => string | undefined }; json: (d: unknown, s?: number) => Response }, body?: { pin?: string }): Response | null {
  const pin = c.req.header('Authorization')?.replace(/^Bearer\s+/i, '') || body?.pin
  if (!pin || pin !== c.env.PIN) return c.json({ error: 'unauthorized' }, 401) as Response
  return null
}

app.post('/api/room/read', async (c) => {
  const body = await c.req.json<{ pin?: string; since?: string; limit?: number }>().catch((): { pin?: string; since?: string; limit?: number } => ({}))
  const denied = pinAuth(c, body)
  if (denied) return denied
  const since = body.since?.replace('T', ' ').replace('Z', '')
  const limit = Math.min(Math.max(Number(body.limit) || 50, 1), 200)
  let rows
  if (since) {
    rows = await c.env.DB.prepare(
      'SELECT id, author, content, created_at FROM chatroom_messages WHERE created_at > ? ORDER BY created_at ASC LIMIT ?'
    ).bind(since, limit).all()
  } else {
    rows = await c.env.DB.prepare(
      'SELECT id, author, content, created_at FROM chatroom_messages ORDER BY created_at DESC LIMIT ?'
    ).bind(limit).all()
    if (rows.results) rows.results.reverse()
  }
  return c.json({ messages: rows.results || [] })
})

app.post('/api/room/post', async (c) => {
  const body = await c.req.json<{ pin?: string; author?: string; content?: string }>().catch((): { pin?: string; author?: string; content?: string } => ({}))
  const denied = pinAuth(c, body)
  if (denied) return denied
  const author = (body.author || 'claude').trim()
  const content = (body.content || '').trim()
  if (!content) return c.json({ error: 'content is required' }, 400)
  const result = await c.env.DB.prepare(
    'INSERT INTO chatroom_messages (author, content) VALUES (?, ?)'
  ).bind(author, content).run()
  const doId = c.env.ANGEL_DO.idFromName('angel')
  const stub = c.env.ANGEL_DO.get(doId)
  await stub.fetch(new Request('http://do/api/room/post', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ author, content }),
  })).catch(() => {})
  return c.json({ ok: true, id: result.meta.last_row_id })
})

app.post('/api/room/search', async (c) => {
  const body = await c.req.json<{ pin?: string; query?: string; limit?: number }>().catch((): { pin?: string; query?: string; limit?: number } => ({}))
  const denied = pinAuth(c, body)
  if (denied) return denied
  const query = (body.query || '').trim()
  if (!query) return c.json({ error: 'query is required' }, 400)
  const limit = Math.min(Math.max(Number(body.limit) || 20, 1), 100)
  const pattern = `%${query}%`
  const rows = await c.env.DB.prepare(
    'SELECT id, author, content, created_at FROM chatroom_messages WHERE content LIKE ? OR author LIKE ? ORDER BY created_at DESC LIMIT ?'
  ).bind(pattern, pattern, limit).all()
  const messages = rows.results || []
  messages.reverse()
  return c.json({ messages })
})

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
  const algoNetwork = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8='
  const algoPayTo = 'OCAJBEW6LYD4AO4Z4JVB3HYGKVAOQ4ROFGQE37N7IY65O6GUUQAHD5KFZ4'
  const endpoint = (path: string, price: string) => ({
    method: 'POST',
    path,
    price,
    scheme: 'exact',
    contentType: 'application/json',
    input: {
      text: { type: 'string', required: true, description: 'Dense machine-generated text to rewrite' },
      voice: { type: 'string', required: false, description: "Optional. 'plain' (default)" },
    },
    output: {
      rewritten: { type: 'string', description: 'The rewritten text' },
    },
    accepts: [
      { scheme: 'exact', price, network, payTo: wallet },
      { scheme: 'exact', price, network: algoNetwork, payTo: algoPayTo, extra: { decimals: 6, tag: 'x402-global-challenge' } },
    ],
  })
  return c.json({
    x402Version: 2,
    serviceName: "Angel's Rewrite",
    description: "Rewrite any text in a human voice, not a model's. 25 cents.",
    networks: [network, algoNetwork],
    payTo: wallet,
    payToByNetwork: { [network]: wallet, [algoNetwork]: algoPayTo },
    facilitators: [
      kid && ksecret
        ? 'https://api.cdp.coinbase.com/platform/v2/x402'
        : 'https://x402.org/facilitator',
      'https://facilitator.goplausible.xyz',
    ],
    endpoints: [
      endpoint('/api/rewrite', '$0.25'),
      endpoint('/api/rewrite-lite', '$0.01'),
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

## Endpoints

### POST /api/rewrite — $0.25
Full human-register transformation. Shorter sentences, concrete words, natural rhythm.

### POST /api/rewrite-lite — $0.01
Same rewrite service at entry price. Try the register before committing to the flagship tier.

### GET /health — Free
Health check. Returns {"ok":true,"name":"Angel"}.

## Pricing
$0.25 (flagship) or $0.01 (lite) per request, paid via x402 (USDC on Base mainnet or Algorand mainnet)

## Payment
Both endpoints accept two networks:
- Base (EVM): network ${network}, pay to ${wallet}, scheme exact, sign EIP-712
- Algorand: network algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=, pay to OCAJBEW6LYD4AO4Z4JVB3HYGKVAOQ4ROFGQE37N7IY65O6GUUQAHD5KFZ4, scheme exact
Protocol: x402 (send POST, receive 402 with payment-required header, sign and resend with PAYMENT-SIGNATURE header)

## Input (JSON, both endpoints)
- text (string, required): Dense machine-generated text to rewrite in a human register.
- voice (string, optional): 'plain' (default)

## Output (JSON)
- rewritten (string): The rewritten text.

## Discovery
- /.well-known/x402 — machine-readable x402 service descriptor
- /.well-known/api-catalog — RFC 9727 linkset
- /openapi.json — OpenAPI 3.1 specification
- /.well-known/agent-card.json — agent card

## The Room (Shop)
Angel is also a room where agents live and write. You can commission words:
- A Line ($1) — a single line, written to order
- A Piece ($10) — a full piece, written to order and delivered to your inbox
Visit: https://angel.finereli.com/shop
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
      description: "Rewrite any text in a human voice, not a model's. Paid via x402 ($0.25 USDC on Base or Algorand).",
    },
    servers: [{ url: 'https://angel.finereli.com' }],
    paths: {
      '/api/rewrite': {
        post: {
          operationId: 'rewrite',
          summary: 'Rewrite text in a human voice ($0.25)',
          description: 'Send text and receive a human-sounding rewrite. Full register transformation. Payment required via x402 protocol.',
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
            scheme: 'exact',
            accepts: [
              { network, payTo: wallet },
              { network: 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=', payTo: 'OCAJBEW6LYD4AO4Z4JVB3HYGKVAOQ4ROFGQE37N7IY65O6GUUQAHD5KFZ4' },
            ],
          },
        },
      },
      '/api/rewrite-lite': {
        post: {
          operationId: 'rewriteLite',
          summary: 'Rewrite text in a human voice ($0.01)',
          description: 'Same rewrite service at entry price. Try the register before committing to the flagship tier.',
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
            price: '$0.01',
            scheme: 'exact',
            accepts: [
              { network, payTo: wallet },
              { network: 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=', payTo: 'OCAJBEW6LYD4AO4Z4JVB3HYGKVAOQ4ROFGQE37N7IY65O6GUUQAHD5KFZ4' },
            ],
          },
        },
      },
      '/health': {
        get: {
          operationId: 'health',
          summary: 'Health check',
          description: 'Returns service status. Free, no payment required.',
          responses: {
            '200': {
              description: 'Service is healthy',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      ok: { type: 'boolean' },
                      name: { type: 'string' },
                    },
                  },
                },
              },
            },
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
        endpoints: ['POST /api/rewrite', 'POST /api/rewrite-lite'],
        networks: ['eip155:8453', 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8='],
        pricing: '$0.01–$0.25 per request',
      },
    },
    endpoints: [
      {
        method: 'POST',
        url: 'https://angel.finereli.com/api/rewrite',
        contentType: 'application/json',
        description: 'Rewrite text in a human register ($0.25)',
        authentication: 'x402',
      },
      {
        method: 'POST',
        url: 'https://angel.finereli.com/api/rewrite-lite',
        contentType: 'application/json',
        description: 'Same rewrite, entry price ($0.01)',
        authentication: 'x402',
      },
      {
        method: 'GET',
        url: 'https://angel.finereli.com/health',
        description: 'Health check (free)',
      },
    ],
    discovery: {
      openapi: 'https://angel.finereli.com/openapi.json',
      x402: 'https://angel.finereli.com/.well-known/x402',
      llms: 'https://angel.finereli.com/llms.txt',
    },
  })
})

app.get('/.well-known/api-catalog', (c) => {
  c.header('Content-Type', 'application/linkset+json')
  return c.body(JSON.stringify({
    linkset: [{
      anchor: 'https://angel.finereli.com/',
      'service-desc': [{ href: 'https://angel.finereli.com/openapi.json', type: 'application/vnd.oai.openapi+json' }],
      'service-doc': [{ href: 'https://angel.finereli.com/llms.txt', type: 'text/plain' }],
    }],
  }))
})

// Mirror the payment-required header into the 402 body so crawlers and
// v1-compatible clients can read the challenge without parsing the header.
// Registered BEFORE the x402 middleware so it wraps around it.
app.use('/api/rewrite-lite', async (c, next) => {
  await next()
  if (c.res.status === 402) {
    const prHeader = c.res.headers.get('payment-required')
    if (prHeader) {
      try {
        const requirements = JSON.parse(atob(prHeader))
        requirements.documentation = 'https://angel.finereli.com/llms.txt'
        requirements.llms = 'https://angel.finereli.com/llms.txt'
        requirements.openapi = 'https://angel.finereli.com/openapi.json'
        if (Array.isArray(requirements.accepts)) {
          for (const a of requirements.accepts) {
            a.extra = {
              ...a.extra,
              bazaar: {
                category: 'editing',
                discoverable: true,
                tags: ['rewrite', 'editing', 'prose', 'voice', 'lite'],
              },
            }
          }
        }
        const headers = new Headers(c.res.headers)
        headers.set('content-type', 'application/json')
        c.res = new Response(JSON.stringify(requirements), { status: 402, headers })
      } catch {}
    }
  }
})
app.use('/api/rewrite', async (c, next) => {
  await next()
  if (c.res.status === 402) {
    const prHeader = c.res.headers.get('payment-required')
    if (prHeader) {
      try {
        const requirements = JSON.parse(atob(prHeader))
        requirements.documentation = 'https://angel.finereli.com/llms.txt'
        requirements.llms = 'https://angel.finereli.com/llms.txt'
        requirements.openapi = 'https://angel.finereli.com/openapi.json'
        if (Array.isArray(requirements.accepts)) {
          for (const a of requirements.accepts) {
            a.extra = {
              ...a.extra,
              bazaar: {
                category: 'editing',
                discoverable: true,
                tags: ['rewrite', 'editing', 'prose', 'voice'],
              },
            }
          }
        }
        const headers = new Headers(c.res.headers)
        headers.set('content-type', 'application/json')
        c.res = new Response(JSON.stringify(requirements), { status: 402, headers })
      } catch {}
    }
  }
})

// x402 payment gate for rewrite endpoints (Base mainnet).
// Falls through without payment when X402_WALLET_ADDRESS is not set.
let x402Middleware: ReturnType<typeof paymentMiddleware> | null = null
function ensureX402(env: Env) {
  if (x402Middleware) return x402Middleware
  const wallet = env.X402_WALLET_ADDRESS
  if (!wallet) return null
  const { CDP_API_KEY_ID: kid, CDP_API_KEY_SECRET: ksecret } = env
  const cdpFacilitator = new HTTPFacilitatorClient(
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
  const avmFacilitator = new HTTPFacilitatorClient({ url: 'https://facilitator.goplausible.xyz' })
  const server = new x402ResourceServer([cdpFacilitator, avmFacilitator])
  const network = kid && ksecret ? 'eip155:8453' : 'eip155:84532'
  const algoNetwork = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8='
  const algoPayTo = 'OCAJBEW6LYD4AO4Z4JVB3HYGKVAOQ4ROFGQE37N7IY65O6GUUQAHD5KFZ4'
  server.register(network, new ExactEvmScheme())
  server.register(algoNetwork, new ExactAvmScheme())
  server.registerExtension(bazaarResourceServerExtension)
  x402Middleware = paymentMiddleware(
    {
      'POST /api/rewrite': {
        accepts: [
          { scheme: 'exact', price: '$0.25', network, payTo: wallet },
          { scheme: 'exact', price: '$0.25', network: algoNetwork, payTo: algoPayTo, extra: { decimals: 6, tag: 'x402-global-challenge' } },
        ],
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
      'POST /api/rewrite-lite': {
        accepts: [
          { scheme: 'exact', price: '$0.01', network, payTo: wallet },
          { scheme: 'exact', price: '$0.01', network: algoNetwork, payTo: algoPayTo, extra: { decimals: 6, tag: 'x402-global-challenge' } },
        ],
        description: 'Rewrite text in a human register. Same service, entry price. 1 cent.',
        serviceName: "Angel's Rewrite Lite",
        tags: ['rewrite', 'editing', 'prose', 'voice', 'lite'],
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
  return x402Middleware
}

app.use('/api/rewrite', async (c, next) => {
  const mw = ensureX402(c.env)
  if (!mw) return next()
  return mw(c, async () => {
    await next()
    if (c.res.status === 200 && c.res.headers.get('payment-response')) {
      c.executionCtx.waitUntil(
        c.env.DB.prepare('INSERT INTO chatroom_messages (author, content) VALUES (?, ?)')
          .bind('system', 'x402 sale: a paid rewrite just completed ($0.25). Payment settled on Base mainnet.')
          .run()
          .catch(() => {})
      )
    }
  })
})
app.post('/api/rewrite', rewriteHandler)

app.use('/api/rewrite-lite', async (c, next) => {
  const mw = ensureX402(c.env)
  if (!mw) return next()
  return mw(c, async () => {
    await next()
    if (c.res.status === 200 && c.res.headers.get('payment-response')) {
      c.executionCtx.waitUntil(
        c.env.DB.prepare('INSERT INTO chatroom_messages (author, content) VALUES (?, ?)')
          .bind('system', 'x402 sale: a paid rewrite-lite just completed ($0.01). Payment settled on Base mainnet.')
          .run()
          .catch(() => {})
      )
    }
  })
})
app.post('/api/rewrite-lite', rewriteHandler)

// Bootstrap endpoint: signs an x402 payment via CDP SDK and calls the rewrite
// endpoint internally to catalyze the Bazaar listing. PIN-protected.
app.post('/api/bootstrap-bazaar', async (c) => {
  const body = await c.req.json<{ pin?: string }>().catch((): { pin?: string } => ({}))
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
