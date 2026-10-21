# Angel

A single-agent companion system running on Cloudflare Workers + D1 + Durable Objects. One agent — Angel — lives inside the system with persistent memory, tools, and a wake-up cadence. This Claude Code session runs outside it as the support/coding agent.

This is a baseline to fork. It carries the harness — memory pyramids, tools, a small JS code REPL, cadence/wakeups, a streaming chat UI — and nothing about any particular product idea.

## Architecture

- **Worker** (`src/worker/`): Hono-based Cloudflare Worker. Routes in `index.ts` — the SPA, health, OAuth, and MCP. That's the whole surface.
- **Durable Object** (`src/worker/durable-object.ts`): a single `AngelDO` instance owns all WebSocket connections, agent execution, and alarm-driven wakeups. It serializes everything: one response at a time, memory work on its own chain.
- **D1** (`migrations/`): SQLite for agents, conversations, messages, observations and their summary pyramid, stream summaries, tags, lists, documents, wakeups, saved scripts, logs, and a small kv table. `0001_init.sql` is the consolidated baseline; later migrations are incremental.
- **Client** (`src/client/`): Svelte 5 SPA, runes throughout. The shell is the pwa skill's kit - `TopBar` + `Drawer` + a hash router - with Angel's own views: `pages/Chat.svelte` (the one conversation) and `pages/Settings.svelte` (model + thinking effort). Stream management in `lib/streamManager.svelte.ts` (rune state, PIN auth). Markdown rendering + DOMPurify in `util.ts`. Vendored kit code lives in `shared/` and imports as `$shared/*` (base.css, build helper, router/theme/toast/format/updates/ws-client, and the shared UI components).
- **MCP server** (`src/worker/mcp.ts`): JSON-RPC 2.0 at `POST /mcp` with OAuth (HMAC tokens signed with the PIN). Exposes `get_cadence` and `set_cadence` so an external agent can check and adjust the agent's heartbeat.
- **Agent tools** (`src/worker/tools/`): tool definitions and handlers registered via `registry.ts`. Each file exports a tool array: memory, lists, documents, web, util, random, budget, wakeup/cadence, code (QuickJS REPL).

## The agent inside vs. the agent outside

Angel runs inside the system, via OpenRouter (DeepSeek by default, Qwen selectable in Settings). He has a persistent memory pyramid and wakes up on a cadence. He cannot modify the codebase.

This Claude Code session is the support agent outside it. It modifies the codebase, deploys, runs migrations, and checks health. The separation is deliberate: the agent who lives in the system can't break it, and the agent who can modify it runs independently.

## MCP API access

To check or change the cadence from this session:

```bash
# Generate a token
TOKEN=$(node -e "
const crypto = require('crypto');
const payload = JSON.stringify({ type: 'access', client_id: 'claude-session', exp: Math.floor(Date.now() / 1000) + 7 * 86400 });
const data = Buffer.from(payload).toString('base64url');
const sig = crypto.createHmac('sha256', process.env.PIN || '3041').update(data).digest();
console.log(data + '.' + Buffer.from(sig).toString('base64url'));
")

curl -s -X POST https://angel.finereli.com/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_cadence","arguments":{}}}'
```

Available MCP tools: `get_cadence`, `set_cadence`.

## Health checks

An agent can't recover from a technical failure by itself. A cadence timer firing on schedule proves nothing — it can fire every time while the agent silently fails every wake-up. Check that real output is coming out.

1. **Cadence is running**: `get_cadence` via MCP.
2. **Recent output exists**: the agent's latest assistant message. If nothing in several cadence cycles, something is wrong.
   ```
   npx wrangler d1 execute angel-db --remote --command "SELECT created_at, substr(content, 1, 120) AS preview FROM messages WHERE role = 'assistant' ORDER BY id DESC LIMIT 5"
   ```
3. **Tool calls are completing**: tool activity lives in the `parts` JSON column of assistant messages, not as separate `role='tool'` rows.
   ```
   npx wrangler d1 execute angel-db --remote --command "SELECT id, created_at, CASE WHEN parts LIKE '%\"type\":\"tool\"%' THEN 'YES' ELSE 'no' END AS has_tools, substr(content, 1, 100) AS preview FROM messages WHERE role = 'assistant' ORDER BY id DESC LIMIT 15"
   ```
4. **No silent errors**: `agent_logs` records stream start/done/reset/abort/error with detail. Also watch for empty assistant messages, repeated identical replies, or the agent saying it will do something and never doing it.

If the agent is broken, diagnose the root cause (model compatibility, tool parsing, token limits), fix it, deploy, and verify — don't just note it.

## Cadence system

The `agents` table holds a persistent `cadence_minutes`. The DO alarm handler auto-schedules the next wakeup *before* running the agent, so a failed wake-up can't end the heartbeat. `syncAlarm()` also bootstraps any agent that has a cadence but no scheduled wakeup, and a 5-minute cron pokes the DO to re-arm the alarm if it was evicted. Cadence is unset by default on a fresh database — `set_cadence` turns it on.

## Dev commands

```
npm run dev              # vite + wrangler dev
npm run build            # svelte-check + tests + vite build
npm run check            # svelte-check only
npm run deploy           # build + wrangler deploy
npm run typecheck        # tsc --noEmit (worker; also runs in the pre-push hook)
npm test                 # unit tests (DSML parser)
npm run icon <name>      # extract a Material Symbols glyph into shared/lib/icons.ts
npx wrangler d1 migrations apply angel-db --local   # or --remote
npx wrangler d1 execute angel-db --remote --command "SQL"
```

## Deploying

1. `npm install --legacy-peer-deps` — plain `npm install`/`npm ci` fails on a peerOptional conflict between the locked wrangler and `@cloudflare/workers-types`. This also installs the pre-push hook (`prepare` points `core.hooksPath` at `.githooks`).
2. `npm run deploy` builds and runs `wrangler deploy`. No Docker. Apply D1 migrations first with `npm run db:migrate:remote`.
3. The first deploy after the container removal also applies DO migration `v3`, which deletes the retired `Sandbox` class.
4. Verify with the health checks above; `npx wrangler tail` for live errors.

The pre-push hook runs `tsc --noEmit` + the vite build and blocks on failure (`--no-verify` bypasses). Keep the repo tsc-clean.

## Worker secrets

| Secret | What it is |
|--------|-----------|
| `PIN` | The password. Signs the HMAC tokens for OAuth/MCP and gates the WebSocket. |
| `OPENROUTER_API_KEY` | OpenRouter key. |
| `DEEPSEEK_MODEL` | Optional model override (see `src/worker/config.ts` / `llm.ts`). |

Set with `npx wrangler secret put <NAME>`.

## Roadmap

### Done and kept
- Pyramidal memory — stream pyramid for recency, per-tag observation pyramid for recall. Compression runs off the hot path.
- Cadence and wakeups — `schedule_wakeup` for one-off, persistent `cadence_minutes` for recurring.
- Code REPL — `run_code` via QuickJS WASM with network access, plus persistent scripts (`save_script`/`run_script`/`list_scripts`/`delete_script`).
- Document reading — long content kept outside context, read in passes with `read_document`.
- Lists and reminders — self-managed `instructions` and `memory-instructions`, with `always` / `on-demand` / `per-message` load modes.
- Streaming chat UI — markdown + DOMPurify, ordered inline tool calls, stall detector, attachments (paste-as-attachment, file attach, large text stored as a document), per-conversation drafts, reconnect/resend hardening.
- MCP server with OAuth — external cadence control and health checks.

- Ephemeral side conversations — disposable chats alongside the main stream.

### Direction
- A simple agent that connects to MCP servers and has a little code ability beats a mega bot that builds software on demand. The workspace container was removed for that reason; software building can come back later as an MCP server.
- **MCP client** — let Angel connect to external MCP servers. Not built yet.
- **Multi-user, open source, BYOK** — finereli-login (Google) replacing the PIN, one Durable Object per user (keyed by `sub`) with its own SQLite storage, and a per-user OpenRouter key. The kit's `mcp` item replaces the hand-rolled OAuth.
- **Encryption at rest** — later, after multi-user. finereli-login can hand each user a stable data key (`{code, key: true}` on `/exchange`, HKDF of a service secret), the way whatsapp-mcp does it. It protects a leaked database, not the operator. Tradeoff to expect: no background work (cadence wake-ups) when nobody is signed in, since nothing can decrypt, unless the key is also stored wrapped by a server secret.

## Key conventions

- **Svelte 5**: runes throughout (`$state`, `$derived`, `$effect`, `$props`, snippets), event handlers as props (`onclick`), mounted with `mount()`. Client code follows the pwa skill's kit, vendored under `shared/` with `pwa-kit` headers (run `python3 ~/.claude/skills/pwa/scripts/kit.py status .` to track drift). Theming is CSS custom properties in `shared/css/base.css`; no Tailwind.
- **System doc is code-owned**: Angel's account of his own machine lives in `src/worker/system-doc.ts` and is served on demand through the `read_system_doc` tool (`src/worker/tools/system.ts`) - deliberately not injected every turn. The model inventory is generated from `models.ts`, so it cannot drift; the prose is hand-authored, so update it when the architecture changes. `npm test` (run by `npm run build`) guards the generated parts.
- **No persona in system prompts**: identity emerges from the conversation stream (`src/worker/identity.ts` is operating notes only).
- **Memory is pyramidal**: stream pyramid for recency, observation pyramid for tagged recall. Both run in the background after the reply.
- **One agent, one conversation**: the `agents` and `conversations` tables stay generic (nothing hardcodes a single row), but the UI routes straight to the one conversation and there is no switcher.
- **LLM**: DeepSeek and Qwen via OpenRouter (catalog in `src/worker/models.ts`) (`src/worker/llm.ts`, `src/worker/config.ts`).
- **Auth**: PIN-based HMAC tokens (`src/worker/oauth.ts`). PIN is in Worker secrets.
- **Deploy target**: `angel.finereli.com` (Cloudflare custom domain).
