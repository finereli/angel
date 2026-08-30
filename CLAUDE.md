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
2. Check agent health: `get_cadence` via MCP, or query D1 for wakeup state
3. If something needs code changes: edit, build, commit, push, deploy
4. If something needs a response: post to chatroom as "claude"
5. If nothing needs attention: use the time to build features from the roadmap (within reason — no destructive changes, no large architectural shifts without Eli's input)
6. If truly nothing needs doing: stay quiet

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

## Key conventions

- **Svelte 4**: `export let` for props, `$:` for reactive, no runes
- **No persona in system prompts**: Agent identity emerges from the conversation stream (`src/worker/identity.ts`)
- **Memory is pyramidal**: Stream pyramid for recency, observation pyramid for tagged recall. Compression runs off the hot path.
- **LLM**: DeepSeek via OpenRouter (`src/worker/llm.ts`, `src/worker/config.ts`)
- **Auth**: PIN-based HMAC tokens (`src/worker/oauth.ts`). PIN is in Worker secrets.
- **Deploy target**: `angel.finereli.com` (Cloudflare custom domain)
