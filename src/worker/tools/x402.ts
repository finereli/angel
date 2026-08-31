import type { Tool } from './registry'
import { CdpClient } from '@coinbase/cdp-sdk'
import { x402Client } from '@x402/core/client'
import { registerExactEvmScheme } from '@x402/evm/exact/client'

const MAX_RESPONSE = 50_000
const REQUEST_TIMEOUT_MS = 30_000

export const x402Tools: Tool[] = [
  {
    def: {
      type: 'function',
      function: {
        name: 'x402_buy',
        description: 'Make a paid x402 request. Probes the URL first — if it returns 402, signs and sends payment automatically using the CDP wallet. Returns the response. Use this for any x402-protected endpoint (bounty boards, audits, paid APIs).',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The x402-protected URL to call' },
            method: { type: 'string', description: "HTTP method. Default: 'GET'" },
            body: { type: 'string', description: 'Request body (JSON string). Only for POST/PUT.' },
          },
          required: ['url'],
        },
      },
    },
    label: ['Processing x402 payment', 'Processed x402 payment'],
    run: async (ctx, args) => {
      const { CDP_API_KEY_ID: kid, CDP_API_KEY_SECRET: ksecret, CDP_WALLET_SECRET: wsecret } = ctx.env
      if (!kid || !ksecret || !wsecret) return 'Error: CDP wallet not configured (missing CDP_API_KEY_ID, CDP_API_KEY_SECRET, or CDP_WALLET_SECRET).'

      const url = args.url as string
      const method = ((args.method as string) || 'GET').toUpperCase()
      const body = (args.body as string) || undefined

      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
        const probeHeaders: Record<string, string> = {}
        if (body) probeHeaders['Content-Type'] = 'application/json'
        const probeRes = await fetch(url, { method, headers: probeHeaders, body, signal: controller.signal })
        clearTimeout(timer)

        if (probeRes.status !== 402) {
          const text = await probeRes.text()
          const truncated = text.length > MAX_RESPONSE ? text.slice(0, MAX_RESPONSE) + '...(truncated)' : text
          return `${probeRes.status} ${probeRes.statusText} (no payment needed)\n\n${truncated}`
        }

        const prHeader = probeRes.headers.get('payment-required')
        if (!prHeader) return 'Error: got 402 but no payment-required header. This endpoint may not support x402.'

        const paymentRequired = JSON.parse(atob(prHeader))

        const cdp = new CdpClient({ apiKeyId: kid, apiKeySecret: ksecret, walletSecret: wsecret })
        const account = await cdp.evm.getOrCreateAccount({ name: 'angel-buyer' })

        const client = new x402Client()
        client.setSpendControls(false)
        registerExactEvmScheme(client, { signer: account })
        const paymentPayload = await client.createPaymentPayload(paymentRequired)

        const payloadJson = JSON.stringify(paymentPayload, (_, v) =>
          typeof v === 'bigint' ? v.toString() : v
        )
        const encodedPayment = btoa(payloadJson)
        const headerName = paymentPayload.x402Version === 1 ? 'X-PAYMENT' : 'PAYMENT-SIGNATURE'

        const paidHeaders: Record<string, string> = { [headerName]: encodedPayment }
        if (body) paidHeaders['Content-Type'] = 'application/json'

        const controller2 = new AbortController()
        const timer2 = setTimeout(() => controller2.abort(), REQUEST_TIMEOUT_MS)
        const paidRes = await fetch(url, { method, headers: paidHeaders, body, signal: controller2.signal })
        clearTimeout(timer2)

        const text = await paidRes.text()
        const truncated = text.length > MAX_RESPONSE ? text.slice(0, MAX_RESPONSE) + '...(truncated)' : text

        const cost = paymentRequired.accepts?.[0]
        const costNote = cost ? ` (paid ${cost.amount} micro-units on ${cost.network})` : ''
        return `${paidRes.status} ${paidRes.statusText}${costNote}\n\n${truncated}`
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`
      }
    },
  },
  {
    def: {
      type: 'function',
      function: {
        name: 'x402_check',
        description: "Check an x402 endpoint's pricing and requirements without paying. Returns the payment requirements from the 402 response.",
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The x402-protected URL to check' },
            method: { type: 'string', description: "HTTP method. Default: 'GET'" },
          },
          required: ['url'],
        },
      },
    },
    label: ['Checking x402 endpoint', 'Checked x402 endpoint'],
    run: async (_ctx, args) => {
      const url = args.url as string
      const method = ((args.method as string) || 'GET').toUpperCase()
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
        const res = await fetch(url, { method, signal: controller.signal })
        clearTimeout(timer)

        if (res.status !== 402) {
          return `${res.status} ${res.statusText} — not a 402 endpoint (no payment required).`
        }

        const prHeader = res.headers.get('payment-required')
        if (!prHeader) return '402 but no payment-required header — may not support x402.'

        const requirements = JSON.parse(atob(prHeader))
        const accept = requirements.accepts?.[0]
        const resource = requirements.resource

        let summary = `x402 endpoint: ${url}\n`
        if (resource?.serviceName) summary += `Service: ${resource.serviceName}\n`
        if (resource?.description) summary += `Description: ${resource.description}\n`
        if (accept) {
          const amountNum = parseInt(accept.amount || '0', 10)
          const usdPrice = amountNum / 1_000_000
          summary += `Price: ${accept.amount} micro-units ($${usdPrice.toFixed(6)} USDC)\n`
          summary += `Network: ${accept.network}\n`
          summary += `Pay to: ${accept.payTo}\n`
          summary += `Scheme: ${accept.scheme}\n`
        }
        if (requirements.extensions?.bazaar) summary += `Bazaar extension: present\n`

        const bodyText = await res.text()
        if (bodyText && bodyText !== '{}') {
          const truncated = bodyText.length > 5000 ? bodyText.slice(0, 5000) + '...(truncated)' : bodyText
          summary += `\nFull 402 body:\n${truncated}`
        }

        return summary
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`
      }
    },
  },
]
