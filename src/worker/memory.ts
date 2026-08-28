// The observation layer: tags, observations, a per-tag summary pyramid, and
// RAG over both observations and summaries. See docs/pyramid-spec.md §2.
import type { Env, TagRow, ObservationRow, ObservationSummaryRow } from './types'
import { OBS } from './config'
import { chatCompletion } from './llm'

// ---- Tags ----
export async function createTag(env: Env, name: string, description: string): Promise<string> {
  const existing = await getTag(env, name)
  if (existing) return existing.id
  const id = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO tags (id, name, description) VALUES (?, ?, ?)`
  ).bind(id, name, description).run()
  return id
}

export async function getTag(env: Env, name: string): Promise<TagRow | null> {
  return env.DB.prepare(`SELECT * FROM tags WHERE name = ?`).bind(name).first<TagRow>()
}

export async function getAllTags(env: Env): Promise<TagRow[]> {
  return (await env.DB.prepare(`SELECT * FROM tags ORDER BY updated_at DESC`).all<TagRow>()).results
}

export async function updateTagDescription(env: Env, name: string, description: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE tags SET description = ?, updated_at = datetime('now') WHERE name = ?`
  ).bind(description, name).run()
}

// ---- Observations ----
export async function addObservation(
  env: Env, content: string, tagNames: string[], source: string, conversationId?: string
): Promise<number> {
  const result = await env.DB.prepare(
    `INSERT INTO observations (content, source, conversation_id) VALUES (?, ?, ?)`
  ).bind(content, source, conversationId ?? null).run()
  const obsId = result.meta.last_row_id as number

  for (const name of Array.from(new Set(tagNames))) { // dedupe so counts don't drift
    // Auto-create missing tags so an observation is never lost.
    const tagId = await createTag(env, name, '')
    await env.DB.prepare(
      `INSERT OR IGNORE INTO observation_tags (observation_id, tag_id) VALUES (?, ?)`
    ).bind(obsId, tagId).run()
    await env.DB.prepare(
      `UPDATE tags SET observation_count = observation_count + 1, updated_at = datetime('now') WHERE id = ?`
    ).bind(tagId).run()
  }

  await embed(env, 'observation', obsId, content)
  return obsId
}

// ---- Per-tag observation summary pyramid (greedy, provenance-tracked) ----
// Cap summaries created per invocation so a backlog can't blow the subrequest
// limit or run long; the rest rolls up on subsequent turns.
const MAX_SUMMARIES_PER_BUILD = 6

export async function buildObservationPyramid(env: Env): Promise<void> {
  const tags = await getAllTags(env)
  const budget = { left: MAX_SUMMARIES_PER_BUILD }
  for (const tag of tags) {
    if (budget.left <= 0) break
    await rollupTag(env, tag.id, tag.name, budget)
  }
}

async function rollupTag(env: Env, tagId: string, tagName: string, budget: { left: number }): Promise<void> {
  // Tier 0: batch unsummarized observations
  let unsummarized = await getUnsummarizedObservations(env, tagId)
  while (unsummarized.length >= OBS.OBS_BATCH && budget.left > 0) {
    const batch = unsummarized.slice(0, OBS.OBS_BATCH)
    await createObsSummary(env, tagId, 0, tagName,
      batch.map(o => ({ type: 'observation' as const, id: o.id, text: o.content, ts: o.created_at, count: 1 })))
    budget.left--
    unsummarized = unsummarized.slice(OBS.OBS_BATCH)
  }

  // Higher tiers: batch unsummarized tier-t summaries into tier-(t+1)
  for (let tier = 0; tier < 8 && budget.left > 0; tier++) {
    let pending = await getUnsummarizedSummaries(env, tagId, tier)
    if (pending.length < OBS.SUM_BATCH) break
    while (pending.length >= OBS.SUM_BATCH && budget.left > 0) {
      const batch = pending.slice(0, OBS.SUM_BATCH)
      await createObsSummary(env, tagId, tier + 1, tagName,
        batch.map(s => ({ type: 'summary' as const, id: s.id, text: s.text, ts: s.end_ts || s.created_at, count: s.source_count })))
      budget.left--
      pending = pending.slice(OBS.SUM_BATCH)
    }
  }
}

async function getUnsummarizedObservations(env: Env, tagId: string): Promise<ObservationRow[]> {
  // "Unsummarized for THIS tag": an observation tagged to several tags must be
  // rolled up once per tag, so scope the exclusion to summaries of this tag.
  return (await env.DB.prepare(
    `SELECT o.* FROM observations o
     JOIN observation_tags ot ON ot.observation_id = o.id
     WHERE ot.tag_id = ?
       AND NOT EXISTS (
         SELECT 1 FROM summary_sources ss
         JOIN observation_summaries os ON os.id = ss.summary_id
         WHERE ss.source_type = 'observation' AND ss.source_id = o.id AND os.tag_id = ?
       )
     ORDER BY o.created_at ASC, o.id ASC`
  ).bind(tagId, tagId).all<ObservationRow>()).results
}

async function getUnsummarizedSummaries(env: Env, tagId: string, tier: number): Promise<ObservationSummaryRow[]> {
  return (await env.DB.prepare(
    `SELECT s.* FROM observation_summaries s
     LEFT JOIN summary_sources ss ON ss.source_type = 'summary' AND ss.source_id = s.id
     WHERE s.tag_id = ? AND s.tier = ? AND ss.summary_id IS NULL
     ORDER BY s.created_at ASC, s.id ASC`
  ).bind(tagId, tier).all<ObservationSummaryRow>()).results
}

async function createObsSummary(
  env: Env, tagId: string, tier: number, tagName: string,
  sources: Array<{ type: 'observation' | 'summary'; id: number; text: string; ts: string; count: number }>
): Promise<void> {
  const body = sources.map(s => s.text).join('\n\n')
  const text = await compressObs(env, body, tier, tagName)
  const sourceCount = sources.reduce((n, s) => n + s.count, 0)  // true observations beneath this tile
  const res = await env.DB.prepare(
    `INSERT INTO observation_summaries (tag_id, tier, text, source_count, start_ts, end_ts)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(tagId, tier, text, sourceCount, sources[0]!.ts, sources[sources.length - 1]!.ts).run()
  const summaryId = res.meta.last_row_id as number

  for (const s of sources) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO summary_sources (summary_id, source_type, source_id) VALUES (?, ?, ?)`
    ).bind(summaryId, s.type, s.id).run()
  }
  await embed(env, 'obs_summary', summaryId, text)
}

async function compressObs(env: Env, body: string, tier: number, tagName: string): Promise<string> {
  const system = `You are Angel, compressing your own memory about "${tagName}" into a tier-${tier} note.
Keep specifics (names, dates, numbers), causal turns, and the texture that matters. Drop redundancy and generic filler.
Write in your own voice - this is your memory, not a report. First person is fine.`
  const result = await chatCompletion(env, [
    { role: 'system', content: system },
    { role: 'user', content: body },
  ], { temperature: 0.3, max_tokens: 1024 })
  return result.content || ''
}

// ---- Embeddings + RAG ----
export async function embed(env: Env, sourceType: string, sourceId: number, text: string): Promise<void> {
  try {
    const vec = await generateEmbedding(env, text)
    if (vec.length === 0) return // don't store empty vectors (they poison cosine with NaN)
    await env.DB.prepare(
      `INSERT OR REPLACE INTO embeddings (source_type, source_id, vector) VALUES (?, ?, ?)`
    ).bind(sourceType, sourceId, JSON.stringify(vec)).run()
  } catch {
    // embedding failures are non-fatal
  }
}

export async function generateEmbedding(env: Env, text: string): Promise<number[]> {
  const result = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [text] }) as { data: number[][] }
  return result.data[0] || []
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]! }
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export interface RecallHit {
  kind: 'observation' | 'summary'
  text: string
  label: string   // e.g. "tag · tier-2 · 37 obs" or a date
  score: number
}

// Search observations AND per-tag summaries; label each by level and backing count.
export async function recall(env: Env, query: string, limit = 8): Promise<RecallHit[]> {
  const queryVec = await generateEmbedding(env, query)
  if (queryVec.length === 0) return []

  // Page through embeddings by id so a large memory never returns one huge D1
  // result (which would blow the result-size cap and break recall entirely).
  const PAGE = 500
  const top: Array<{ source_type: string; source_id: number; score: number }> = []
  let afterId = 0
  for (;;) {
    const page = (await env.DB.prepare(
      `SELECT id, source_type, source_id, vector FROM embeddings WHERE id > ? ORDER BY id LIMIT ?`
    ).bind(afterId, PAGE).all<{ id: number; source_type: string; source_id: number; vector: string }>()).results
    if (page.length === 0) break
    for (const r of page) {
      afterId = r.id
      let vec: number[]
      try { vec = JSON.parse(r.vector) } catch { continue }
      if (!vec.length) continue
      const score = cosineSimilarity(queryVec, vec)
      if (Number.isNaN(score)) continue
      top.push({ source_type: r.source_type, source_id: r.source_id, score })
    }
    if (page.length < PAGE) break
  }
  const scored = top.sort((a, b) => b.score - a.score).slice(0, limit)

  const hits: RecallHit[] = []
  for (const m of scored) {
    if (m.source_type === 'observation') {
      const o = await env.DB.prepare(
        `SELECT content, created_at FROM observations WHERE id = ?`
      ).bind(m.source_id).first<{ content: string; created_at: string }>()
      if (o) hits.push({ kind: 'observation', text: o.content, label: o.created_at.slice(0, 10), score: m.score })
    } else if (m.source_type === 'obs_summary') {
      const s = await env.DB.prepare(
        `SELECT s.text, s.tier, s.source_count, t.name as tag
         FROM observation_summaries s JOIN tags t ON t.id = s.tag_id WHERE s.id = ?`
      ).bind(m.source_id).first<{ text: string; tier: number; source_count: number; tag: string }>()
      if (s) hits.push({
        kind: 'summary', text: s.text,
        label: `${s.tag} · tier-${s.tier} · ${s.source_count} obs`, score: m.score,
      })
    }
  }
  return hits.sort((a, b) => b.score - a.score)
}

export async function getMemoryStats(env: Env): Promise<{ tags: number; observations: number; summaries: number }> {
  const results = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) as c FROM tags`),
    env.DB.prepare(`SELECT COUNT(*) as c FROM observations`),
    env.DB.prepare(`SELECT COUNT(*) as c FROM observation_summaries`),
  ])
  return {
    tags: (results[0]!.results[0]! as { c: number }).c,
    observations: (results[1]!.results[0]! as { c: number }).c,
    summaries: (results[2]!.results[0]! as { c: number }).c,
  }
}
