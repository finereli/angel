// The stream pyramid: index-0 anchored, immutable tiles, logarithmic recency
// compression of the one linear conversation stream. See docs/pyramid-spec.md §1.
import type { Env, StreamSummaryRow } from './types'
import { STREAM } from './config'
import { chatCompletion } from './llm'

export interface Pair {
  idx: number
  userContent: string
  userTs: string
  assistantContent: string
  assistantTs: string | null
  conversationId: string
  topic: string | null
  title: string | null
}

export async function getTotalPairs(env: Env, conversationId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) as c FROM messages WHERE role = 'user' AND conversation_id = ?`
  ).bind(conversationId).first<{ c: number }>()
  return row?.c || 0
}

export async function getPairsInRange(env: Env, conversationId: string, startIdx: number, endIdx: number): Promise<Pair[]> {
  if (endIdx < startIdx) return []
  const users = await env.DB.prepare(
    `WITH u AS (
       SELECT id, conversation_id, content, created_at,
              ROW_NUMBER() OVER (ORDER BY created_at, id) - 1 AS idx
       FROM messages WHERE role = 'user' AND conversation_id = ?
     )
     SELECT u.idx, u.id, u.conversation_id, u.content, u.created_at,
            c.topic, c.title
     FROM u JOIN conversations c ON c.id = u.conversation_id
     WHERE u.idx BETWEEN ? AND ?
     ORDER BY u.idx`
  ).bind(conversationId, startIdx, endIdx).all<{
    idx: number; id: number; conversation_id: string; content: string;
    created_at: string; topic: string | null; title: string | null
  }>()

  const pairs: Pair[] = []
  for (const u of users.results) {
    const nextUser = await env.DB.prepare(
      `SELECT MIN(id) as nid FROM messages WHERE role = 'user' AND conversation_id = ? AND id > ?`
    ).bind(conversationId, u.id).first<{ nid: number | null }>()
    const upper = nextUser?.nid ?? Number.MAX_SAFE_INTEGER
    const asst = await env.DB.prepare(
      `SELECT content, created_at FROM messages
       WHERE role = 'assistant' AND conversation_id = ? AND content IS NOT NULL AND content != ''
         AND id > ? AND id < ?
       ORDER BY id ASC`
    ).bind(conversationId, u.id, upper).all<{ content: string; created_at: string }>()
    pairs.push({
      idx: u.idx,
      userContent: u.content,
      userTs: u.created_at,
      assistantContent: asst.results.map(a => a.content).join('\n\n'),
      assistantTs: asst.results.length ? asst.results[asst.results.length - 1]!.created_at : null,
      conversationId: u.conversation_id,
      topic: u.topic,
      title: u.title,
    })
  }
  return pairs
}

// ---- Build: bottom-up, count-based, idempotent, background ----
// Cap tiles built per invocation so a large backlog (e.g. after downtime) can't
// exceed the per-event subrequest limit; the rest builds on subsequent turns.
const MAX_TILES_PER_BUILD = 8

export async function buildStreamPyramid(env: Env, agentId: string, conversationId: string): Promise<void> {
  const total = await getTotalPairs(env, conversationId)
  if (total < 1) return
  const agent = await env.DB.prepare(`SELECT name FROM agents WHERE id = ?`).bind(agentId).first<{ name: string }>()
  const agentName = agent?.name || agentId
  const verbatimStart = Math.max(0, total - STREAM.VERBATIM)
  let built = 0

  for (let tier = 1; tier <= STREAM.MAX_TIER; tier++) {
    const size = STREAM.WIDTH ** tier
    const existing = new Set(
      (await env.DB.prepare(`SELECT start_index FROM stream_summaries WHERE agent_id = ? AND tier = ?`)
        .bind(agentId, tier).all<{ start_index: number }>()).results.map(r => r.start_index)
    )
    let start = 0
    while (start + size <= verbatimStart) {
      const end = start + size - 1
      if (!existing.has(start)) {
        if (tier === 1) {
          await buildTier1Tile(env, agentId, agentName, conversationId, start, end)
          built++
        } else {
          const children = (await env.DB.prepare(
            `SELECT * FROM stream_summaries WHERE agent_id = ? AND tier = ? AND start_index >= ? AND end_index <= ?
             ORDER BY start_index`
          ).bind(agentId, tier - 1, start, end).all<StreamSummaryRow>()).results
          if (children.length >= STREAM.WIDTH) {
            await buildHigherTile(env, agentId, agentName, tier, start, end, children)
            built++
          }
        }
        if (built >= MAX_TILES_PER_BUILD) { await pruneStream(env, agentId, total); return }
      }
      start += size
    }
  }

  await pruneStream(env, agentId, total)
}

async function buildTier1Tile(env: Env, agentId: string, agentName: string, conversationId: string, start: number, end: number): Promise<void> {
  const pairs = await getPairsInRange(env, conversationId, start, end)
  if (pairs.length === 0) return
  const body = pairs.map(p =>
    `Eli: ${p.userContent}\nMe: ${p.assistantContent}`
  ).join('\n\n')
  const text = await compressStream(env, agentName, body, 1)
  await insertTile(env, agentId, 1, start, end, text, pairs.length,
    pairs[0]!.userTs, pairs[pairs.length - 1]!.assistantTs || pairs[pairs.length - 1]!.userTs)
}

async function buildHigherTile(
  env: Env, agentId: string, agentName: string, tier: number, start: number, end: number, children: StreamSummaryRow[]
): Promise<void> {
  const body = children.map(c => c.text).join('\n\n---\n\n')
  const text = await compressStream(env, agentName, body, tier)
  const sourceCount = children.reduce((n, c) => n + c.source_count, 0)
  await insertTile(env, agentId, tier, start, end, text, sourceCount,
    children[0]!.start_ts, children[children.length - 1]!.end_ts)
}

async function insertTile(
  env: Env, agentId: string, tier: number, start: number, end: number,
  text: string, sourceCount: number, startTs: string | null, endTs: string | null
): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO stream_summaries
       (agent_id, tier, start_index, end_index, start_ts, end_ts, text, source_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(agentId, tier, start, end, startTs, endTs, text, sourceCount).run()
}

// First-person compressor: Angel remembering, not a report. Spec §4.1.
async function compressStream(env: Env, agentName: string, body: string, tier: number): Promise<string> {
  const system = tier === 1
    ? `You are ${agentName}. Write a short recap of this stretch of conversation with Eli in your own voice, so you can remember it later. Say what you got into, what he was turning over, what shifted, where you left it. Write to Eli as "you" and to yourself as "I"; never refer to yourself in the third person. Warm and plain, not a report. A few sentences.`
    : `You are ${agentName}. Combine these recaps of earlier conversation with Eli into one, in your own voice, dropping redundancy but keeping what mattered - decisions, turns, the texture. Write to Eli as "you" and to yourself as "I"; never third person. A short paragraph.`
  const result = await chatCompletion(env, [
    { role: 'system', content: system },
    { role: 'user', content: body },
  ], { temperature: 0.3, max_tokens: 700 })
  return result.content || ''
}

async function pruneStream(env: Env, agentId: string, total: number): Promise<void> {
  const horizon = total - STREAM.KEEP_FACTOR * (STREAM.WIDTH ** STREAM.MAX_TIER) - STREAM.VERBATIM
  if (horizon <= 0) return
  await env.DB.prepare(`DELETE FROM stream_summaries WHERE agent_id = ? AND end_index < ?`).bind(agentId, horizon).run()
}

// ---- Render: pure DB, fill-down + present-emulating ramp. Spec §1.6 ----
export async function renderStreamContext(env: Env, agentId: string, conversationId: string): Promise<{ tiles: StreamSummaryRow[]; verbatim: Pair[]; total: number }> {
  const total = await getTotalPairs(env, conversationId)
  if (total === 0) return { tiles: [], verbatim: [], total }
  let verbatimStart = Math.max(0, total - STREAM.VERBATIM)

  const all = (await env.DB.prepare(`SELECT * FROM stream_summaries WHERE agent_id = ?`).bind(agentId).all<StreamSummaryRow>()).results
  const coverageEnd = (tier: number): number => {
    const t = all.filter(s => s.tier === tier)
    return t.length ? Math.max(...t.map(s => s.end_index)) : -1
  }

  // Pass 1: fill-down (coverage)
  const result: StreamSummaryRow[] = []
  let fillUntil = verbatimStart - 1
  for (let tier = 1; tier <= STREAM.MAX_TIER && fillUntil >= 0; tier++) {
    const nextTierEnd = coverageEnd(tier + 1)
    const band = all.filter(s => s.tier === tier && s.start_index > nextTierEnd && s.end_index <= fillUntil)
    result.push(...band)
    fillUntil = nextTierEnd
  }
  const topTier = result.length ? Math.max(...result.map(s => s.tier)) : 0

  // Pass 2: ramp (gradient by deliberate duplication) - top each tier up to RAMP most-recent
  const inResult = new Set(result.map(s => `${s.tier}:${s.start_index}`))
  for (let tier = 1; tier <= topTier; tier++) {
    const have = result.filter(s => s.tier === tier).length
    if (have >= STREAM.RAMP) continue
    const recent = all
      .filter(s => s.tier === tier && s.end_index < verbatimStart && !inResult.has(`${s.tier}:${s.start_index}`))
      .sort((a, b) => b.start_index - a.start_index)
      .slice(0, STREAM.RAMP - have)
    for (const s of recent) { result.push(s); inResult.add(`${s.tier}:${s.start_index}`) }
  }

  // oldest first; coarse before fine at a tie
  result.sort((a, b) => a.start_index - b.start_index || b.tier - a.tier)

  // verbatim back-extension: pull the window back to just after the last tile so a
  // not-yet-summarized partial chunk is shown in full rather than falling through.
  const lastEnd = result.length ? Math.max(...result.map(s => s.end_index)) : -1
  verbatimStart = Math.min(verbatimStart, lastEnd + 1)
  const verbatim = await getPairsInRange(env, conversationId, verbatimStart, total - 1)

  return { tiles: result, verbatim, total }
}
