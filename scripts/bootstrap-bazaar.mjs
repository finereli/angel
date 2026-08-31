#!/usr/bin/env node
// Bootstrap the Bazaar listing by making the first paid x402 request.
// Usage: BUYER_PRIVATE_KEY=0x... node scripts/bootstrap-bazaar.mjs

import { privateKeyToAccount } from 'viem/accounts'
import { x402Client, x402HTTPClient } from '@x402/core/client'
import { registerExactEvmScheme } from '@x402/evm/exact/client'

const ENDPOINT = 'https://angel.finereli.com/api/rewrite'
const TEST_TEXT = 'The system has been configured to process textual input and generate output that has been optimized for human consumption patterns. Users are advised that the transformation pipeline applies multiple heuristic layers to ensure compliance with readability standards.'

const key = process.env.BUYER_PRIVATE_KEY
if (!key) {
  console.error('Set BUYER_PRIVATE_KEY=0x... (a wallet with ≥0.25 USDC on Base mainnet)')
  process.exit(1)
}

const account = privateKeyToAccount(key)
console.log(`Buyer wallet: ${account.address}`)

const client = new x402Client()
registerExactEvmScheme(client, { signer: account })
const httpClient = new x402HTTPClient(client)

// Step 1: Hit the endpoint, get the 402
console.log(`\nRequesting ${ENDPOINT}...`)
const initialRes = await fetch(ENDPOINT, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: TEST_TEXT }),
})

if (initialRes.status !== 402) {
  console.log(`Unexpected status: ${initialRes.status}`)
  console.log(await initialRes.text())
  process.exit(1)
}

// Step 2: Decode the payment requirements
const paymentRequired = httpClient.getPaymentRequiredResponse(
  (name) => initialRes.headers.get(name),
)
console.log(`Payment required: $${Number(paymentRequired.accepts[0].amount) / 1e6} USDC on ${paymentRequired.accepts[0].network}`)

// Step 3: Create signed payment payload
console.log('Signing payment...')
const paymentPayload = await httpClient.createPaymentPayload(paymentRequired)
const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload)

// Step 4: Retry with payment
console.log('Sending paid request...')
const paidRes = await fetch(ENDPOINT, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...paymentHeaders,
  },
  body: JSON.stringify({ text: TEST_TEXT }),
})

console.log(`\nResponse: ${paidRes.status} ${paidRes.statusText}`)
const body = await paidRes.text()
console.log(body)

if (paidRes.ok) {
  console.log('\n✓ Bootstrap payment succeeded! The listing should now be cataloged in the Bazaar directory.')
} else {
  console.log('\n✗ Payment failed. Check the error above.')
}
