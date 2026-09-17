// Assembles what a conversation's turns look like to the agent. The main line
// reads from the stream pyramid (recaps + a verbatim tail); a side conversation
// reads from its frozen seed (a render of the main line at branch time) plus its
// own verbatim tail. Side chats never touch the pyramid.
import type { Env, ChatMessage, ConversationRow, ConversationInfo, StreamSummaryRow } from './types'
import { STREAM } from './config'
import { getTotalPairs, getPairsInRange, renderStreamContext, type Pair } from './stream-pyramid'

export async function getConversation(env: Env, id: string): Promise<ConversationRow | null> {
  return env.DB.prepare(`SELECT * FROM conversations WHERE id = ?`).bind(id).first<ConversationRow>()
}

export function conversationInfo(c: ConversationRow): ConversationInfo {
  return {
    id: c.id,
    title: c.title,
    parentId: c.parent_id,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  }
}

const dateLine = (ts: string | null): string => (ts ? ts.slice(0, 10) : '')

// The stream pyramid spliced as prior turns - Angel's own memory, first person.
export function recapTurns(tiles: StreamSummaryRow[]): ChatMessage[] {
  if (tiles.length === 0) return []
  const recap = tiles.map(t => t.text).join('\n\n')
  return [
    { role: 'user', content: `(picking up where we left off - my memory of earlier)\n\n${recap}` },
    { role: 'assistant', content: "Right - that's where we've been." },
  ]
}

// Verbatim tail as real prior turns, each marked with date + thread topic.
// Skip unanswered pairs (an in-flight message from another thread, or a turn that
// errored before saving a reply) so they can't appear as history to answer.
export function verbatimTurns(pairs: Pair[]): ChatMessage[] {
  const msgs: ChatMessage[] = []
  for (const p of pairs) {
    if (!p.assistantContent) continue
    const marker = `[${dateLine(p.userTs)}]`
    msgs.push({ role: 'user', content: `${marker} ${p.userContent}` })
    msgs.push({ role: 'assistant', content: p.assistantContent })
  }
  return msgs
}

// The frozen main-line render, spliced as prior turns so a side chat opens with
// where the main line stood when it branched.
function seedTurns(seed: string): ChatMessage[] {
  if (!seed.trim()) return []
  return [
    { role: 'user', content: `(picking up from the main line where we branched - my memory of it)\n\n${seed}` },
    { role: 'assistant', content: "Right - that's where we were." },
  ]
}

export interface SideInfo {
  title: string | null
  seedAt: string | null
}

export interface ConversationContext {
  recap: ChatMessage[] // synthetic prior turns (main recaps, or the side seed)
  verbatim: Pair[] // real prior pairs
  total: number
  side: SideInfo | null
}

export async function loadConversationContext(
  env: Env, agentId: string, conversationId: string,
): Promise<ConversationContext> {
  const conv = await getConversation(env, conversationId)
  const total = await getTotalPairs(env, conversationId)

  if (conv?.parent_id) {
    // Side conversation: seed + its own recent pairs. No pyramid.
    const start = Math.max(0, total - STREAM.VERBATIM)
    const verbatim = total > 0 ? await getPairsInRange(env, conversationId, start, total - 1) : []
    return { recap: seedTurns(conv.seed || ''), verbatim, total, side: { title: conv.title, seedAt: conv.seed_at } }
  }

  const { tiles, verbatim } = await renderStreamContext(env, agentId, conversationId)
  return { recap: recapTurns(tiles), verbatim, total, side: null }
}

// The main line's context rendered to one text block, frozen as a side chat's
// seed at creation. Recaps first, then the recent exchanges verbatim.
export async function renderSeedText(env: Env, agentId: string, conversationId: string): Promise<string> {
  const { tiles, verbatim } = await renderStreamContext(env, agentId, conversationId)
  const parts: string[] = []
  if (tiles.length) parts.push(tiles.map(t => t.text).join('\n\n'))
  for (const p of verbatim) parts.push(`Eli: ${p.userContent}\nMe: ${p.assistantContent}`)
  return parts.join('\n\n')
}
