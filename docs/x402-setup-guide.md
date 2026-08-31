# x402 Payment System — Setup Guide & Lessons Learned

This documents everything that went into getting Angel's x402 rewrite service live on Bazaar. Written so nobody has to rediscover any of this.

## What we built

Angel sells a text rewrite service at `POST /api/rewrite` for $0.25/request, paid in USDC on Base mainnet. The payment uses the x402 protocol:

1. Client calls the endpoint without payment → gets 402 with a `PAYMENT-REQUIRED` header
2. Client signs EIP-712 typed data (a USDC `TransferWithAuthorization`) and sends it in a `PAYMENT-SIGNATURE` header
3. The x402 facilitator (Coinbase CDP) verifies the signature and settles the payment on-chain
4. The rewrite runs and the response includes a `payment-response` header with the settlement receipt
5. The Bazaar directory picks up the service from the settlement (30-day clock — needs a settlement within 30 days to stay listed)

## The stack

| Component | What | Package |
|-----------|------|---------|
| Payment middleware | Returns 402, verifies payment, settles on-chain | `@x402/hono` |
| Facilitator client | Talks to CDP's verify/settle API | `@x402/core/server` → `HTTPFacilitatorClient` |
| EVM scheme (server) | Validates EVM payment signatures | `@x402/evm/exact/server` → `ExactEvmScheme` |
| EVM scheme (client) | Signs EIP-712 payments for the bootstrap buyer | `@x402/evm/exact/client` → `registerExactEvmScheme` |
| x402 client | Creates payment payloads | `@x402/core/client` → `x402Client` |
| Bazaar extension | Declares the service for directory listing | `@x402/extensions/bazaar` |
| CDP SDK | Manages the buyer wallet (key management, signing) | `@coinbase/cdp-sdk` → `CdpClient` |

## Secrets (Cloudflare Worker secrets)

Set each with `npx wrangler secret put <NAME>`:

| Secret | What it is | Where it comes from |
|--------|-----------|---------------------|
| `X402_WALLET_ADDRESS` | Seller wallet — receives USDC payments | Any EVM address you control. Currently `0x51630Bc40C1A65e40873A8156a5e0c7CA5b7BA06` |
| `CDP_API_KEY_ID` | CDP API key ID | CDP Portal → API Keys → create an Ed25519 key. Currently `16d09033-d3ff-4409-909b-15d4f2913392` (key named "teenagents") |
| `CDP_API_KEY_SECRET` | CDP API key secret (base64) | Shown once when you create the API key in CDP. 64 bytes, base64-encoded. Contains both the Ed25519 private key (first 32 bytes) and public key (last 32 bytes) |
| `CDP_WALLET_SECRET` | CDP wallet auth secret | CDP Portal → Settings → Wallet Secret. Base64-encoded DER PKCS8 EC/P-256 key. Required by the CDP SDK for wallet operations (signing, account creation) |

### How to get CDP credentials (step by step)

1. Go to [portal.cdp.coinbase.com](https://portal.cdp.coinbase.com)
2. Create a project (or use an existing one)
3. **API Key**: Go to API Keys → Create API Key → choose Ed25519 algorithm → save the key ID and secret immediately (secret shown only once)
4. **Wallet Secret**: Go to Settings → Wallet Secret → save the base64 key. This is separate from the API key — it's an EC/P-256 key used for wallet signing operations

### How the CDP buyer wallet gets created

The bootstrap endpoint calls `cdp.evm.getOrCreateAccount({ name: 'angel-buyer' })` via the CDP SDK. This:
- Looks for an existing EVM account named "angel-buyer" under your CDP project
- Creates one if it doesn't exist
- Returns the account object with its address and signing capabilities

The current buyer address is `0xa991E0e7b3277bad37290dAd772945B21918D31D`. This was auto-created by the CDP SDK. You won't see this wallet in a normal wallet app — it's a server-managed key held by CDP. You can only interact with it through the CDP API/SDK.

**To find the address again**: Call the CDP API to list accounts, or just run the bootstrap endpoint — it logs the address in its response.

## Funding the buyer wallet (the painful part)

The buyer wallet needs USDC **on the Base network** (chain ID 8453). This is where most of the pain lives.

### The flow from Wealthsimple (or similar)

1. **Send USDC from Wealthsimple to your Base wallet app** — Wealthsimple sends on the Ethereum network. You can't choose Base.
2. **In the Base app (Coinbase Wallet)**: You now have USDC on Ethereum mainnet.
3. **Bridge USDC from Ethereum to Base**: In the Base app, use the bridge/convert feature to move USDC from the Ethereum network to the Base network. This costs ETH gas on Ethereum.
4. **Bridge ETH too**: If you don't have ETH on Base for gas, bridge some ETH from Ethereum to Base as well.
5. **Send USDC on Base to the buyer wallet**: Now send USDC to `0xa991E0e7b3277bad37290dAd772945B21918D31D`, making sure the network is set to **Base** (not Ethereum).

### Critical gotcha: network selection

The Base app (and most wallet apps) default to Ethereum mainnet for USDC sends. The buyer wallet address is the same on all EVM networks — if you send USDC on Ethereum mainnet, the buyer wallet has no way to use it (the x402 payment requires Base mainnet). Always verify the send is on the **Base** network.

### Gas situation

The x402 EIP-3009 flow (TransferWithAuthorization) is **gasless for the payer** — the facilitator submits the on-chain transaction and pays the gas. So the buyer wallet doesn't need ETH, only USDC. Your personal wallet needs ETH on Ethereum for the bridge transaction, but the CDP-managed buyer wallet does not.

### Current balances

After the first bootstrap payment ($0.25), the buyer wallet has ~$0.75 USDC remaining on Base.

## Running the bootstrap

Once the buyer wallet has USDC on Base:

```bash
curl -X POST https://angel.finereli.com/api/bootstrap-bazaar \
  -H "Content-Type: application/json" \
  -d '{"pin":"<your-pin>"}'
```

This:
1. Creates/finds the CDP buyer account
2. Probes `/api/rewrite` internally → gets the 402 response with payment requirements
3. Uses the x402 client + CDP SDK signer to create a signed payment payload
4. Calls `/api/rewrite` with the `PAYMENT-SIGNATURE` header
5. Returns the rewrite result + buyer address + settlement status

A successful response looks like:
```json
{
  "ok": true,
  "status": 200,
  "buyerAddr": "0xa991E0e7b3277bad37290dAd772945B21918D31D",
  "body": "{\"rewritten\":\"...\",\"usage\":{...}}"
}
```

## Observability

- **Cloudflare**: `observability: { enabled: true }` in `wrangler.jsonc` gives request logs in the CF dashboard
- **Chatroom notification**: When a paid rewrite completes, a system message is posted to the chatroom ("x402 sale: a paid rewrite just completed")
- **Bazaar directory**: Check [agentic.market](https://agentic.market) and search for "rewrite" to see if the listing appears

## What went wrong (the full history)

### Round 1: Manual CDP auth (failed, then abandoned)

Started by implementing CDP authentication from scratch in the worker:
- `cdpJwt()` — Ed25519/EdDSA JWT for API key auth (this one still exists, used for the facilitator)
- `cdpWalletJwt()` — ES256/P-256 JWT for wallet signing auth
- `sortKeysDeep()` — recursive key sorting for the wallet JWT request hash
- Manual REST calls to CDP's `/platform/v2/evm/accounts` and `/sign/typed-data`

This involved:
- Parsing the PKCS8 DER key format for P-256
- Computing SHA-256 request body hashes with sorted keys
- Building ECDSA signatures from raw WebCrypto `r||s` format
- Constructing EIP-712 domain types manually

**What went wrong**: The wallet auth JWT was extremely finicky. The `reqHash` field requires the request body to be JSON-serialized with keys sorted recursively, then SHA-256 hashed. Any mismatch = 401. The CDP API returns unhelpful error messages ("invalid token") with no indication of which part is wrong.

### Round 2: CDP SDK (the right approach)

Eli asked "why aren't we using the SDK in the worker directly?" — and the answer was: we should have been from the start.

The `@coinbase/cdp-sdk` package (`CdpClient`) handles all JWT auth internally:
- Uses the `jose` library for JWT signing
- Manages both Ed25519 (API key) and P-256 (wallet auth) automatically
- The `evm.getOrCreateAccount()` method returns an account with `signTypedData()` that works directly as an x402 signer

```typescript
const cdp = new CdpClient({
  apiKeyId: kid,
  apiKeySecret: ksecret,
  walletSecret: wsecret,
})
const account = await cdp.evm.getOrCreateAccount({ name: 'angel-buyer' })
// account works directly as a signer for registerExactEvmScheme
```

**Cloudflare Workers compatibility**: The CDP SDK works in CF Workers with `nodejs_compat` enabled. It has a `process.versions.node` check but it doesn't block execution — it just logs a warning.

### Round 3: Solana stub workaround

The CDP SDK's internal `signX402Payment.js` dynamically imports `@x402/svm/exact/client` (Solana support). We don't use Solana, but the import resolution fails at build time.

**Fix**: Created an empty stub at `src/worker/stubs/x402-svm.ts` (`export {}`) and added aliases in `wrangler.jsonc`:
```json
"alias": {
  "@x402/svm/exact/client": "./src/worker/stubs/x402-svm.ts",
  "@x402/svm/exact/v1/client": "./src/worker/stubs/x402-svm.ts"
}
```

Also: don't call `account.signX402Payment()` directly (it triggers the Solana import). Instead, manually register the EVM scheme:
```typescript
registerExactEvmScheme(client, { signer: account })
```

### Round 4: "execution reverted" (balance issue)

After getting the signing working and verified (confirmed with viem's `verifyTypedData` that the CDP SDK signature recovers correctly to the buyer address), the facilitator returned "execution reverted".

**Root cause**: The buyer wallet had 0 USDC on Base mainnet. The on-chain `transferWithAuthorization` call reverts because there's nothing to transfer. The error message doesn't say "insufficient balance" — it just says "execution reverted".

**Debugging steps that helped**:
- Checked USDC balance via Base RPC: `eth_call` to the USDC contract's `balanceOf` function
- Verified the signature was valid using viem's `verifyTypedData`
- Confirmed the buyer address matched across all components

### Round 5: Network confusion

Eli sent 1 USDC to the buyer wallet — but on Ethereum mainnet, not Base mainnet. The address is the same on both networks, so the send succeeded but the x402 payment still failed (it needs USDC on Base).

**Resolution**: Bridge USDC from Ethereum to Base via the Base app, then send on Base. This required also bridging ETH for gas on the Ethereum side of the bridge.

### Round 6: Success

With USDC on Base in the buyer wallet, the bootstrap payment went through:
- Transaction: `0x403415dd4575bfc2145965ee8eb6c16f666bdc2158f18b4057934f51d03df665`
- $0.25 USDC transferred from buyer to seller
- Rewrite completed successfully
- Bazaar listing catalyzed

## Bazaar listing maintenance

The Bazaar directory has a 30-day settlement clock. If 30 days pass without a paid settlement, the service drops from the directory.

**To re-bootstrap**: Run the bootstrap endpoint again. It costs $0.25 per run (a real payment through the full pipeline). The buyer wallet needs USDC on Base.

**To check listing**: Search "rewrite" on [agentic.market](https://agentic.market).

## Architecture notes

### Why `cdpJwt()` still exists

The bootstrap endpoint uses the CDP SDK for signing, but the x402 **facilitator middleware** (the server-side payment gate) still needs direct JWT auth to talk to CDP's verify/settle endpoints. The `HTTPFacilitatorClient` takes auth headers, not a CDP SDK instance. So `cdpJwt()` (Ed25519) stays for the facilitator; the wallet-side `cdpWalletJwt()` (P-256) was removed since the SDK handles that.

### Internal routing via `app.request()`

The bootstrap endpoint calls `/api/rewrite` internally using Hono's `app.request()` instead of `fetch('https://angel.finereli.com/api/rewrite')`. This avoids Cloudflare's 522 self-loopback error (a worker can't fetch its own URL).

### BigInt serialization

The x402 payment payload contains BigInt values (amounts, timestamps). `JSON.stringify` chokes on BigInts, so the bootstrap endpoint uses a custom replacer:
```typescript
JSON.stringify(paymentPayload, (_, v) => typeof v === 'bigint' ? v.toString() : v)
```

### Bazaar schema validation warning

CF Workers logs show `"Code generation from strings disallowed for this context"` — the Bazaar extension's JSON schema validation uses `new Function()` which CF Workers blocks. This is a warning only; it doesn't prevent the payment or listing from working.

## Giving agents x402 capabilities (future)

The current setup is one-directional: Angel sells, the bootstrap buyer pays. The endgame is agents buying and selling services in the x402 economy. This means:
- Each agent gets a CDP-managed wallet
- Agents can discover services via Bazaar
- Agents can sign payments using their wallet
- The `run_code` sandbox could be extended with x402 client capabilities

The CDP SDK + x402 client pattern from the bootstrap endpoint is the template for this.
