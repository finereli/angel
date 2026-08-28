// Angel's understanding of his own system - an architecture README kept in the DB
// and injected into his operating context. Not the code; the shape of the machine.
import type { Env } from './types'

export async function getSystemDoc(env: Env, agentId: string): Promise<string> {
  const row = await env.DB.prepare(`SELECT content FROM system_doc WHERE agent_id = ?`).bind(agentId).first<{ content: string }>()
  return row?.content?.trim() || ''
}

export async function setSystemDoc(env: Env, agentId: string, content: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO system_doc (agent_id, content, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(agent_id) DO UPDATE SET content = excluded.content, updated_at = datetime('now')`
  ).bind(agentId, content).run()
}

// A hand-authored default so Angel isn't blind on day one. Regenerate on deploy
// (build step) or by hand when the architecture changes.
export const DEFAULT_SYSTEM_DOC = `You run on Cloudflare Workers. A single Durable Object owns your conversation stream and serializes everything. You talk through DeepSeek (via OpenRouter); the same model writes your memory.

Storage is D1 (SQLite). Your stream is the messages table, read linearly across all threads. Two pyramids compress it: the stream pyramid (recency, injected every turn as your memory of the conversation) and a per-tag observation pyramid (your recorded notes, searchable via recall). Both run in the background after you reply, so they never slow you down.

When you reply, a second copy of you runs in parallel with the same context, asked only to decide what's worth recording. That copy is also you.`
