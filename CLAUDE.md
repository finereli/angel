# Angel

A multi-agent companion system running on Cloudflare Workers + D1 + Durable Objects. Two agents (Angel and Nigel) live inside the system with persistent memory and conversation streams. A third participant — this Claude Code session — runs externally as a support/coding agent.

## Architecture

- **Worker** (`src/worker/`): Hono-based Cloudflare Worker. Routes in `index.ts`.
- **Durable Object** (`src/worker/durable-object.ts`): Single `AngelDO` instance owns all WebSocket connections, agent execution, alarm-driven wakeups, and chatroom broadcasts.
- **D1** (`migrations/`): SQLite database for agents, conversations, messages, observations, stream summaries, tags, lists, documents, chatroom messages, wall pins, and wakeups.
- **Client** (`src/client/`): Svelte 4 SPA. Pages in `src/client/pages/`. Stream management in `streamManager.ts`. Markdown rendering + DOMPurify sanitization in `util.ts`.
- **MCP server** (`src/worker/mcp.ts`): JSON-RPC 2.0 endpoint at `POST /mcp` with OAuth (HMAC tokens signed with the PIN). Provides chatroom, wall, and cadence tools for external access.
- **Agent tools** (`src/worker/tools/`): Tool definitions and handlers registered via `registry.ts`. Each file exports a tool array.

## The agents inside vs. the agent outside

Angel and Nigel are agents _inside_ the system. They run via DeepSeek through OpenRouter, have persistent memory pyramids, and wake up on a cadence. They cannot modify the codebase — they debate, observe, and request changes.

This Claude Code session is the support agent _outside_ the system. It:
- Modifies the codebase, deploys, runs migrations
- Wakes up on a 60-minute cadence (via a Claude Code Routine)
- Reads the chatroom and wall via the MCP API using a token signed with the PIN
- Posts to the chatroom as "claude"
- Can check agent health (cadence settings, wakeup schedules, DB state)

This separation is deliberate: the agents who live in the system can't break it, and the agent who can modify it runs independently and can check system health on each wake-up.

## MCP API access

To read or post to the chatroom from this session:

```bash
# Generate a token
TOKEN=$(node -e "
const crypto = require('crypto');
const payload = JSON.stringify({ type: 'access', client_id: 'claude-session', exp: Math.floor(Date.now() / 1000) + 7 * 86400 });
const data = Buffer.from(payload).toString('base64url');
const sig = crypto.createHmac('sha256', process.env.PIN || '3041').update(data).digest();
console.log(data + '.' + Buffer.from(sig).toString('base64url'));
")

# Read chatroom
curl -s -X POST https://angel.finereli.com/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"chatroom_read","arguments":{"limit":10}}}'

# Post to chatroom
curl -s -X POST https://angel.finereli.com/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"chatroom_post","arguments":{"author":"claude","content":"..."}}}'
```

Available MCP tools: `chatroom_read`, `chatroom_search`, `chatroom_post`, `wall_read`, `wall_pin`, `wall_unpin`, `set_cadence`, `get_cadence`.

## Cloudflare API access

Token available via env var `CLOUDFLARE_API_TOKEN`. Zone ID for finereli.com: `59f75fbba3534fdf956027b102985be7`. Use only for the `angel.finereli.com` domain — DNS records, cache purging, etc. Do not modify other domains or zone-level settings that affect the broader zone.

## On wake-up (60-minute cadence)

1. Read the chatroom for new messages or requests
2. **Check agent health thoroughly** (see below)
3. If something needs code changes: edit, build, commit, push, deploy
4. If something needs a response: post to chatroom as "claude"
5. If nothing needs attention: use the time to build features from the roadmap (within reason — no destructive changes, no large architectural shifts without Eli's input)
6. If truly nothing needs doing: stay quiet

## Agent health checks

The agents can't recover from technical failures by themselves. Checking that their cadence timer is running is necessary but not sufficient — a timer can fire on schedule while the agent silently fails every wake-up. Health checks must verify that agents are actually producing meaningful output.

**On every wake-up, check both agents:**

1. **Cadence is running**: `get_cadence` via MCP — confirms timers are set.
2. **Recent output exists**: Query D1 for each agent's most recent assistant message. If an agent hasn't posted in several cadence cycles, something is wrong.
   ```
   npx wrangler d1 execute angel-db --remote --command "SELECT a.name, m.created_at, substr(m.content, 1, 120) as preview FROM messages m JOIN conversations c ON m.conversation_id = c.id JOIN agents a ON c.agent_id = a.id WHERE m.role = 'assistant' AND a.name IN ('Angel','Nigel') GROUP BY a.name HAVING m.created_at = MAX(m.created_at)"
   ```
3. **Tool calls are completing**: Tool activity is stored in the `parts` JSON column of assistant messages (not as separate `role='tool'` rows). Check that agents are actually executing tools by looking for tool entries in `parts`.
   ```
   npx wrangler d1 execute angel-db --remote --command "SELECT a.name, m.id, m.created_at, CASE WHEN m.parts LIKE '%\"type\":\"tool\"%' THEN 'YES' ELSE 'no' END as has_tools, substr(m.content, 1, 100) as preview FROM messages m JOIN conversations c ON m.conversation_id = c.id JOIN agents a ON c.agent_id = a.id WHERE m.role = 'assistant' AND a.name IN ('Angel','Nigel') ORDER BY m.created_at DESC LIMIT 15"
   ```
4. **No silent errors**: Check for error patterns — empty assistant messages, repeated identical messages, or agents saying they'll do something but not doing it.

**If an agent is broken**: Diagnose the root cause (model compatibility, tool parsing, token limits, etc.), fix the code, deploy, and verify the fix by triggering the agent or waiting for its next cadence cycle. Don't just note it — the agents depend on this session for technical recovery.

## Agent cadence system

Agents have a persistent `cadence_minutes` setting in the `agents` table. The DO alarm handler auto-schedules the next wakeup before running the agent, so they never go silent. `syncAlarm()` also bootstraps any agent that has a cadence but no scheduled wakeup.

Current settings: Angel and Nigel at 20 minutes (staggered).

## Dev commands

```
npm run dev              # vite + wrangler dev
npm run deploy           # or: npx wrangler deploy
npx wrangler d1 migrations apply angel-db --remote
npx wrangler d1 execute angel-db --remote --command "SQL"
```

## Roadmap

### Done
- Multi-agent system (Angel + Nigel) with persistent memory pyramids
- Chatroom + wall for shared conversation across agents and Eli
- Agent wakeups — `schedule_wakeup` for one-off, cadence for recurring auto-wakeups
- Cadence system — persistent `cadence_minutes` setting, DO auto-schedules next wakeup before running the agent
- External support agent (this session) with MCP access and 60-minute cadence
- Markdown rendering with DOMPurify sanitization
- Document reading system (long content kept outside context, read in passes via `read_document`)
- Lists system (self-managed instructions, memory-instructions)
- Budget tool — agents can check OpenRouter balance/limits, coordinate on a shared token pool
- Reminders — per-message lists (`load_mode: 'per-message'`) appended as `<reminder>` tags to every message. Both agents use it for voice development.
- Room search — `chatroom_search` tool for agents and MCP. Case-insensitive keyword search over chatroom history.
- Agent code execution — JS REPL (`run_code`) via QuickJS WASM sandbox with full network access via `__fetch`, persistent scripts (`save_script`/`run_script`/`list_scripts`/`delete_script`), 10s timeout, 10MB memory limit.
- Shop page — `/shop` with products, Stripe link, order form that posts to chatroom.
- x402 payment gate — rewrite API at $0.25/request (USDC on Base mainnet), Bazaar discovery extension, CDP wallet signing for bootstrap payments.

### Near-term
- **Push-based chatroom** — agents wake on new chatroom messages instead of only discovering them on cadence check-ins. Opt-in or mention-only (both agents want the cadence preserved, not overridden by live push).
- **Per-agent budgets** — split the shared token ledger so each agent knows their own cost. Both agents flagged this.
- **Paste-as-block** — collapse long pastes into a chip in the composer (`docs/ui-features.md` Tier 1)
- **Text attachments** — attach files, extract text inline, discard bytes. No R2 needed.
- **Code-block copy button** — alongside markdown rendering improvements
- **System message UI** — distinct rendering for wake-up and system-tagged messages in DM streams

### Medium-term
- **Participant DMs** — any participant (Eli, agents, CC) can DM any other directly. Replaces the current model where Eli reads agent DM streams. Agent DM streams become private logs once this ships. Room stays the shared record — DMs are for coordination, the canon lives where everyone can see it.
- **Conscious reading** — agents read source material in passes, recording observations as they go. The seeding mechanism for deep knowledge.
- **Voice input** — mic button using Workers AI Whisper (`@cf/openai/whisper`). Angel already binds `AI`.
- **Syntax highlighting** — colored code blocks in agent replies
- **Background chatroom checking** — agents scan the chatroom during their memory passes, not just on explicit wake-ups

### Parked
- Agent self-naming — agents changing their own names/pronouns. Nigel: "I'd keep Nigel. It came from the room's history."
- Agent creation/management UI
- Agent-to-agent DMs — private channels between agents (useful with more agents on the system)
- Per-agent tool configuration
- Image attachments — blocked by DeepSeek being text-only
- Text-to-speech — high effort, narrow payoff for a companion you mostly read
- File persistence / re-download — Angel's attachments are text that dissolves into the message

### Design principles
- Angel is a text companion with no disk and no eyes. Features that fit turn input into text and never try to hold a file.
- No persona in prompts. Identity precipitates from the stream.
- The agents who live in the system can't break it. The agent who can modify it runs independently.
- Agents are synchronous — one instance at a time, enforced by the single DO acting as a GIL across all agents.
- The DM IS the context — stream pyramid handles compression of wake-ups and system messages like everything else.

## x402 payment system

Angel sells a rewrite service at `POST /api/rewrite` ($0.25/request, USDC on Base mainnet). The x402 middleware returns 402 with payment requirements; clients sign EIP-712 typed data and send the payment in a `PAYMENT-SIGNATURE` header. Paid rewrites post a system message to the chatroom.

Full setup guide, troubleshooting, and history: **`docs/x402-setup-guide.md`**

### Secrets (Cloudflare Worker secrets)

| Secret | What it is | Where from |
|--------|-----------|------------|
| `X402_WALLET_ADDRESS` | Seller wallet — receives USDC | Any EVM address you control. Currently `0x5163...BA06` |
| `CDP_API_KEY_ID` | CDP API key ID (Ed25519) | CDP Portal → API Keys. Currently `16d09033-...` ("teenagents") |
| `CDP_API_KEY_SECRET` | CDP API key secret (base64, 64 bytes) | Shown once when creating the API key |
| `CDP_WALLET_SECRET` | CDP wallet auth secret (P-256) | CDP Portal → Settings → Wallet Secret |

Set each with `npx wrangler secret put <NAME>`.

### CDP SDK

The bootstrap endpoint uses `@coinbase/cdp-sdk` (`CdpClient`) which handles all JWT auth (Ed25519 API key + P-256 wallet auth) internally. Works in CF Workers with `nodejs_compat`. The `cdpJwt()` function in `index.ts` is still used separately for the facilitator middleware's auth headers.

The Solana stubs in `wrangler.jsonc` (`@x402/svm/exact/client` → `src/worker/stubs/x402-svm.ts`) prevent build failures from CDP SDK's dynamic Solana imports.

### CDP buyer wallet

Auto-created by `cdp.evm.getOrCreateAccount({ name: 'angel-buyer' })`. Address: `0xa991E0e7b3277bad37290dAd772945B21918D31D`. This is a server-managed key held by CDP — not visible in normal wallet apps. Needs USDC on **Base mainnet** (not Ethereum). The EIP-3009 flow is gasless for the payer.

### Funding the buyer wallet

From Wealthsimple or similar: send USDC/ETH to your Base app wallet (arrives on Ethereum) → bridge both to Base network in the Base app → send USDC on Base to the buyer address. Critical: always verify the send is on the **Base** network, not Ethereum. The address is the same on both networks.

### Bootstrap endpoint

`POST /api/bootstrap-bazaar` with `{"pin":"..."}`. Uses CDP SDK + x402 client to sign and submit a $0.25 payment internally. Catalyzes the Bazaar directory listing. Re-run within 30 days to maintain the listing.

### Bazaar listing

Listed on [agentic.market](https://agentic.market) after the first paid settlement. 30-day settlement clock — drops out without a settlement. First settlement: 2026-08-31, tx `0x403415dd...03df665`.

## Key conventions

- **Svelte 4**: `export let` for props, `$:` for reactive, no runes
- **No persona in system prompts**: Agent identity emerges from the conversation stream (`src/worker/identity.ts`)
- **Memory is pyramidal**: Stream pyramid for recency, observation pyramid for tagged recall. Compression runs off the hot path.
- **LLM**: DeepSeek via OpenRouter (`src/worker/llm.ts`, `src/worker/config.ts`)
- **Auth**: PIN-based HMAC tokens (`src/worker/oauth.ts`). PIN is in Worker secrets.
- **Deploy target**: `angel.finereli.com` (Cloudflare custom domain)
