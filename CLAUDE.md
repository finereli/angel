# Angel

A single-agent companion system running on Cloudflare Workers + D1 + Durable Objects. One agent — Angel — lives inside the system with persistent memory, tools, and a wake-up cadence. This Claude Code session runs outside it as the support/coding agent.

This is a baseline to fork. It carries the harness — memory pyramids, tools, a small JS code REPL, cadence/wakeups, a streaming chat UI — and nothing about any particular product idea.

## Architecture

- **Worker** (`src/worker/`): Hono-based Cloudflare Worker. Routes in `index.ts` — the SPA, health, OAuth, and MCP. That's the whole surface.
- **Durable Object** (`src/worker/durable-object.ts`): one `AngelDO` per user (`idFromName(sub)`, the Google account id) owns that user's WebSocket connections, agent execution, and alarm-driven wakeups. It serializes everything: one response at a time, memory work on its own chain.
- **Per-user storage** (`src/worker/user-db.ts`, `user-schema.ts`): each DO has a private SQLite database (agents, conversations, messages, observations and their summary pyramid, stream summaries, tags, lists, documents, wakeups, saved scripts, logs, kv). `user-db.ts` wraps it in the slice of the D1 API the worker uses and the DO hands it to everything as `env.DB`, so query code is unchanged. Schema changes are new steps appended to `USER_SCHEMA`, applied in the DO constructor. Never edit a shipped step. `wrangler d1 execute` cannot see this data; use the MCP `health_check` tool, or build a diagnostic into the DO.
- **D1** (`migrations/`): the shared control plane only - the `users` table (the cron walks it to re-arm every DO's alarm; MCP finds the owner through it). `0001`-`0003` were the pre-multi-user tables; `0005` drops them (the owner's data was cleared, not imported).
- **Client** (`src/client/`): Svelte 5 SPA, runes throughout. The shell is the pwa skill's kit - `TopBar` + `Drawer` + a hash router - with Angel's own views: `pages/Chat.svelte` (the one conversation) and `pages/Settings.svelte` (model + thinking effort). Stream management in `lib/streamManager.svelte.ts` (rune state, login token auth). Markdown rendering + DOMPurify in `util.ts`. Vendored kit code lives in `shared/` and imports as `$shared/*` (base.css, build helper, router/theme/toast/format/updates/ws-client, and the shared UI components).
- **Sign-in** (`src/worker/access.ts`, `shared/lib/finereli-login.ts`, `shared/functions/verify-login.ts`): login.finereli.com (Google). The client gets a token in a popup; the worker verifies it (`aud` must be this app's origin) on `/ws` and `/api/me`, then forwards the socket to that user's DO with `X-Angel-Sub`. The browser offers the token as a WebSocket subprotocol (`['angel.v1', 'auth.<token>']`). Login only says who someone is: `ALLOWED_EMAILS` (plus `OWNER_EMAIL`) says who may use Angel, because every user still runs on the owner's OpenRouter key. `shared/functions/verify-login.ts` has two `!` added for our stricter tsconfig; fix upstream in finereli-login.
- **MCP server** (`src/worker/mcp.ts`): JSON-RPC 2.0 at `POST /mcp`. Still the old PIN-signed OAuth (`oauth.ts`), and it only speaks for the owner: tools run inside the owner's DO through `POST /api/tool` (`cadence-tools.ts`). Exposes `get_cadence`, `set_cadence` and `health_check`. To be replaced by the kit's `mcp` item (login.finereli.com approval, per-user).
- **Agent tools** (`src/worker/tools/`): tool definitions and handlers registered via `registry.ts`. Each file exports a tool array: memory, lists, documents, web, util, random, budget, wakeup/cadence, code (QuickJS REPL).

## The agent inside vs. the agent outside

Angel runs inside the system, via OpenRouter (DeepSeek by default; Qwen and Haiku selectable in Settings). He has a persistent memory pyramid and wakes up on a cadence. He cannot modify the codebase.

This Claude Code session is the support agent outside it. It modifies the codebase, deploys, runs migrations, and checks health. The separation is deliberate: the agent who lives in the system can't break it, and the agent who can modify it runs independently.

## MCP API access

To check or change the owner's cadence, or run the health check, from this session (the owner must have signed in once, so a `users` row exists). The PIN is the `PIN` Worker secret, now used only for MCP tokens:

```bash
# Generate a token
TOKEN=$(node -e "
const crypto = require('crypto');
const payload = JSON.stringify({ type: 'access', client_id: 'claude-session', exp: Math.floor(Date.now() / 1000) + 7 * 86400 });
const data = Buffer.from(payload).toString('base64url');
const sig = crypto.createHmac('sha256', process.env.PIN).update(data).digest();
console.log(data + '.' + Buffer.from(sig).toString('base64url'));
")

curl -s -X POST https://angel.finereli.com/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_cadence","arguments":{}}}'
```

Available MCP tools: `get_cadence`, `set_cadence`, `health_check`.

## Health checks

An agent can't recover from a technical failure by itself. A cadence timer firing on schedule proves nothing — it can fire every time while the agent silently fails every wake-up. Check that real output is coming out.

1. **Cadence is running**: `get_cadence` via MCP.
2. **Recent output exists, tools complete, no silent errors**: `health_check` via MCP returns the latest assistant messages (with whether each used tools) and recent warnings and errors from `agent_logs`. If nothing in several cadence cycles, something is wrong. Also watch for empty assistant messages, repeated identical replies, or the agent saying it will do something and never doing it.

(The data is in the owner's Durable Object, so the old `wrangler d1 execute ... FROM messages` queries no longer see it.)

If the agent is broken, diagnose the root cause (model compatibility, tool parsing, token limits), fix it, deploy, and verify — don't just note it.

## Cadence system

The `agents` table holds a persistent `cadence_minutes`. The DO alarm handler auto-schedules the next wakeup *before* running the agent, so a failed wake-up can't end the heartbeat. `syncAlarm()` also bootstraps any agent that has a cadence but no scheduled wakeup, and a 5-minute cron pokes every user's DO (from the D1 `users` table) to re-arm the alarm if it was evicted. Cadence is unset by default on a fresh database — `set_cadence` turns it on.

## Dev commands

```
npm run dev              # vite + wrangler dev
npm run build            # svelte-check + tests + vite build
npm run check            # svelte-check only
npm run deploy           # build + wrangler deploy
npm run typecheck        # tsc --noEmit (worker; also runs in the pre-push hook)
npm test                 # unit tests (DSML parser, per-user DB, access, model errors)
npm run icon <name>      # extract a Material Symbols glyph into shared/lib/icons.ts
npx wrangler d1 migrations apply angel-db --local   # or --remote (control plane only)
npx wrangler d1 execute angel-db --remote --command "SQL"
```

## Deploying

1. `npm install --legacy-peer-deps` — plain `npm install`/`npm ci` fails on a peerOptional conflict between the locked wrangler and `@cloudflare/workers-types`. This also installs the pre-push hook (`prepare` points `core.hooksPath` at `.githooks`).
2. `npm run db:migrate:remote` (the D1 `users` table), then `npm run deploy` (build + `wrangler deploy`). No Docker. DO migration `v3` deletes the retired `Sandbox` class.
3. Each user's DO creates and seeds its own schema on first contact, so there is nothing to migrate per user. Settings has "Delete all my data" (`account:reset`), which wipes a user's DO storage and re-seeds it.
4. Local dev: put `DEV_AUTH=allow`, `ALLOWED_EMAILS=dev@localhost` and a real `OPENROUTER_API_KEY` in `.dev.vars` (gitignored), and run `wrangler dev --local-upstream localhost:8787` - without the upstream flag the custom-domain route makes `request.url` the production host and the bypass (which requires `localhost`) stays off.
5. Verify with the health checks above; `npx wrangler tail` for live errors.

The pre-push hook runs `tsc --noEmit` + the vite build and blocks on failure (`--no-verify` bypasses). Keep the repo tsc-clean.

## Worker secrets

| Secret | What it is |
|--------|-----------|
| `PIN` | Signs the HMAC tokens for the legacy MCP OAuth only. The WebSocket no longer uses it. The old default PIN is in git history, so use a fresh one. Goes away with the kit's `mcp` item. |
| `OPENROUTER_API_KEY` | OpenRouter key, shared by every user until BYOK. |

Set with `npx wrangler secret put <NAME>`.

Plain vars in `wrangler.jsonc`: `OWNER_EMAIL` (the account MCP speaks for) and `ALLOWED_EMAILS` (comma-separated; who else may sign in - empty means only the owner).

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
- **Multi-user, open source, BYOK** — sign-in (finereli-login) and one Durable Object per user with its own SQLite are done. Still to do: a per-user OpenRouter key (then open sign-up instead of `ALLOWED_EMAILS`), per-user embeddings cost, and the kit's `mcp` item replacing the hand-rolled OAuth.
- **Encryption at rest** — later, after multi-user. finereli-login can hand each user a stable data key (`{code, key: true}` on `/exchange`, HKDF of a service secret), the way whatsapp-mcp does it. It protects a leaked database, not the operator. Tradeoff to expect: no background work (cadence wake-ups) when nobody is signed in, since nothing can decrypt, unless the key is also stored wrapped by a server secret.

## Key conventions

- **Svelte 5**: runes throughout (`$state`, `$derived`, `$effect`, `$props`, snippets), event handlers as props (`onclick`), mounted with `mount()`. Client code follows the pwa skill's kit, vendored under `shared/` with `pwa-kit` headers (run `python3 ~/.claude/skills/pwa/scripts/kit.py status .` to track drift). Theming is CSS custom properties in `shared/css/base.css`; no Tailwind.
- **System doc is code-owned**: Angel's account of his own machine lives in `src/worker/system-doc.ts` and is served on demand through the `read_system_doc` tool (`src/worker/tools/system.ts`) - deliberately not injected every turn. The model inventory is generated from `models.ts`, so it cannot drift; the prose is hand-authored, so update it when the architecture changes. `npm test` (run by `npm run build`) guards the generated parts.
- **No persona in system prompts**: identity emerges from the conversation stream (`src/worker/identity.ts` is operating notes only).
- **Memory is pyramidal**: stream pyramid for recency, observation pyramid for tagged recall. Both run in the background after the reply.
- **One agent, one conversation**: the `agents` and `conversations` tables stay generic (nothing hardcodes a single row), but the UI routes straight to the one conversation and there is no switcher.
- **LLM**: OpenRouter, through a hand-picked three-model catalog in `src/worker/models.ts` (DeepSeek V4.1 Flash, Qwen3.8 Flash, Claude Haiku 5.5). No server-side model config: the default is `DEFAULT_MODEL` in code, and a saved model that leaves the catalog falls back to it.
- **Errors are for people**: `llm.ts` turns provider failures into plain sentences (`LlmError`, `friendlyError`); the raw text goes to `agent_logs`. Non-retryable ones (bad key, no credit) fail fast; rate limits retry with backoff. An error is never written into the stream (the model would read it as its own words); it is kept per conversation, sent with `conv:messages`, and the chat shows it with Try again (`retry`). (`src/worker/llm.ts`, `src/worker/config.ts`).
- **Auth**: login.finereli.com tokens (`src/worker/access.ts`), checked at the worker, never in the DO. The PIN only signs legacy MCP tokens.
- **Deploy target**: `angel.finereli.com` (Cloudflare custom domain).
