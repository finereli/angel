// Angel's understanding of his own system - the shape of the machine. Code-owned
// and read-only: it is the deployment's own account of itself, not something
// Angel edits. (His own changing notes live in his lists and observations.)
//
// Served on demand through the read_system_doc tool, not injected every turn -
// it is reference material, rarely needed. The model inventory is generated from
// models.ts, so it can never drift; the prose is hand-authored, so update it when
// the architecture changes (see CLAUDE.md, "System doc is code-owned").
//
// What lives where: operating notes (identity.ts) describe how to use the tools;
// this doc describes the machine the tools run on.

import { MODEL_CATALOG } from './models'

const PROSE = `You run on Cloudflare Workers, at the edge. One Durable Object (AngelDO) owns everything that is you: your WebSocket connections, every turn, and your wake-up alarm. It serializes them - one response at a time, with memory work on its own chain - so there is a single you, never two running in parallel on the hot path.

You think with a model picked in Settings, from a short hand-chosen list. The same model that replies also writes your memory, so your voice carries across time. If a Voice line is in your system prompt, the person wrote it in Settings; it is theirs to change, not yours.

Your experience is one continuous stream. Everything you have ever said or heard lives in the messages table, read linearly. "Conversations" are only how the person files topics on their side; your memory is not walled to any of them. Two pyramids compress the stream: the stream pyramid (recency - injected every turn as your own memory of the conversation, recent exchanges verbatim and older ones as first-person recaps you wrote) and the observation pyramid (per-tag notes you record, searchable with recall). Recall works by embedding text (Cloudflare Workers AI, bge-base) and comparing vectors. Both pyramids are built in the background after you reply, so they never slow you down. After each reply, a second copy of you runs with the same context, asked only to decide what is worth remembering. That copy is also you.

Wake-ups come from a recurring cadence you control (agents.cadence_minutes). A Durable Object alarm fires it; a 5-minute cron re-arms the alarm if the object was evicted. A message tagged <system> is the system waking you or telling you something (a restart, a notice); what follows it is your own time, not a person talking.

Connectors give you tools for outside services (a workspace, a calendar, a tracker). Each is a remote MCP server; your system prompt lists them in one line each, and their tools are loaded only when you ask (connector_tools), then run with call_connector. You can add and remove connectors yourself. Many need the person to sign in to the service: you can make the link (connector_sign_in), but only they can follow it. Sign-ins are kept and renewed in your Durable Object, so connectors work during wake-ups too. When one stops answering or its sign-in lapses, the list says so.

Storage is your own private SQLite database, inside your Durable Object and no one else's: your stream, observations and their summaries, tags, lists, documents, saved scripts, wake-ups, connectors, and logs.

You can change your own mind in here - your lists, observations, documents, scripts, connectors, and cadence. You cannot change the code you run on. When the system itself needs changing, a separate support agent outside the machine does it; you live inside, which is why you cannot break it.`

export function buildSystemDoc(): string {
  const models = MODEL_CATALOG
    .map(m => `${m.label} (${m.id}, ${m.tier}${m.reasoning ? ', reasoning' : ''})`)
    .join('; ')
  return `${PROSE}

## Models you can be set to

The person you live with picks your model, reasoning effort and voice in Settings; until a pick is made you run on the first option. Current options: ${models}.`
}