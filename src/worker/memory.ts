import type { Env, ModelRow, ObservationRow, SummaryRow, GlopusModelRow } from './types'

export async function addObservation(
  env: Env,
  content: string,
  modelNames: string[],
  source: string = 'agent',
  conversationId?: string
): Promise<number> {
  const result = await env.DB.prepare(
    `INSERT INTO observations (content, source, conversation_id) VALUES (?, ?, ?)`
  ).bind(content, source, conversationId ?? null).run()

  const obsId = result.meta.last_row_id

  for (const name of modelNames) {
    const model = await env.DB.prepare(
      `SELECT id FROM models WHERE name = ?`
    ).bind(name).first<{ id: string }>()

    if (model) {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO observation_tags (observation_id, model_id) VALUES (?, ?)`
      ).bind(obsId, model.id).run()

      await env.DB.prepare(
        `UPDATE models SET observation_count = observation_count + 1, updated_at = datetime('now') WHERE id = ?`
      ).bind(model.id).run()
    }
  }

  // Embed in background
  await embedObservation(env, obsId, content)

  return obsId
}

export async function createModel(
  env: Env,
  name: string,
  description: string
): Promise<string> {
  const id = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO models (id, name, description) VALUES (?, ?, ?)`
  ).bind(id, name, description).run()
  return id
}

export async function updateModelDescription(
  env: Env,
  name: string,
  description: string
): Promise<void> {
  await env.DB.prepare(
    `UPDATE models SET description = ?, updated_at = datetime('now') WHERE name = ?`
  ).bind(description, name).run()
}

export async function getModel(env: Env, name: string): Promise<ModelRow | null> {
  return env.DB.prepare(
    `SELECT * FROM models WHERE name = ?`
  ).bind(name).first<ModelRow>()
}

export async function getAllModels(env: Env): Promise<ModelRow[]> {
  const result = await env.DB.prepare(
    `SELECT * FROM models ORDER BY updated_at DESC`
  ).all<ModelRow>()
  return result.results
}

export async function getObservationsForModel(
  env: Env,
  modelId: string,
  limit: number = 100
): Promise<ObservationRow[]> {
  const result = await env.DB.prepare(
    `SELECT o.* FROM observations o
     JOIN observation_tags ot ON o.id = ot.observation_id
     WHERE ot.model_id = ?
     ORDER BY o.created_at DESC LIMIT ?`
  ).bind(modelId, limit).all<ObservationRow>()
  return result.results
}

export async function getUnsummarizedObservations(
  env: Env,
  modelId: string
): Promise<ObservationRow[]> {
  const result = await env.DB.prepare(
    `SELECT o.* FROM observations o
     JOIN observation_tags ot ON o.id = ot.observation_id
     LEFT JOIN summary_sources ss ON ss.source_type = 'observation' AND ss.source_id = o.id
     WHERE ot.model_id = ? AND ss.summary_id IS NULL
     ORDER BY o.created_at ASC`
  ).bind(modelId).all<ObservationRow>()
  return result.results
}

export async function saveSummary(
  env: Env,
  modelId: string,
  tier: number,
  content: string,
  sourceType: string,
  sourceIds: number[]
): Promise<number> {
  const result = await env.DB.prepare(
    `INSERT INTO summaries (model_id, tier, content) VALUES (?, ?, ?)`
  ).bind(modelId, tier, content).run()

  const summaryId = result.meta.last_row_id

  for (const sourceId of sourceIds) {
    await env.DB.prepare(
      `INSERT INTO summary_sources (summary_id, source_type, source_id) VALUES (?, ?, ?)`
    ).bind(summaryId, sourceType, sourceId).run()
  }

  return summaryId
}

export async function getSummariesForModel(
  env: Env,
  modelId: string,
  tier?: number
): Promise<SummaryRow[]> {
  if (tier !== undefined) {
    const result = await env.DB.prepare(
      `SELECT * FROM summaries WHERE model_id = ? AND tier = ? ORDER BY created_at DESC`
    ).bind(modelId, tier).all<SummaryRow>()
    return result.results
  }
  const result = await env.DB.prepare(
    `SELECT * FROM summaries WHERE model_id = ? ORDER BY tier ASC, created_at DESC`
  ).bind(modelId).all<SummaryRow>()
  return result.results
}

export async function updatePortrait(
  env: Env,
  modelId: string,
  portrait: string
): Promise<void> {
  await env.DB.prepare(
    `UPDATE models SET portrait = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(portrait, modelId).run()
}

export async function getMemoryStats(env: Env): Promise<{
  models: number
  observations: number
  summaries: number
}> {
  const [models, observations, summaries] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) as c FROM models`),
    env.DB.prepare(`SELECT COUNT(*) as c FROM observations`),
    env.DB.prepare(`SELECT COUNT(*) as c FROM summaries`),
  ])
  return {
    models: (models.results[0] as { c: number }).c,
    observations: (observations.results[0] as { c: number }).c,
    summaries: (summaries.results[0] as { c: number }).c,
  }
}

// Glopus reference memory
export async function getGlopusModels(env: Env): Promise<GlopusModelRow[]> {
  const result = await env.DB.prepare(
    `SELECT * FROM glopus_models ORDER BY observation_count DESC`
  ).all<GlopusModelRow>()
  return result.results
}

export async function getGlopusModel(env: Env, name: string): Promise<GlopusModelRow | null> {
  return env.DB.prepare(
    `SELECT * FROM glopus_models WHERE name = ?`
  ).bind(name).first<GlopusModelRow>()
}

// Embedding helpers
async function embedObservation(env: Env, obsId: number, content: string): Promise<void> {
  try {
    const embedding = await generateEmbedding(env, content)
    await env.DB.prepare(
      `INSERT OR REPLACE INTO embeddings (source_type, source_id, vector) VALUES ('observation', ?, ?)`
    ).bind(obsId, JSON.stringify(embedding)).run()
  } catch {
    // embedding failures are non-fatal
  }
}

export async function generateEmbedding(env: Env, text: string): Promise<number[]> {
  const result = await env.AI.run('@cf/baai/bge-base-en-v1.5', {
    text: [text],
  }) as { data: number[][] }
  return result.data[0]
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

export async function searchMemory(
  env: Env,
  query: string,
  limit: number = 10,
  sourceType?: string
): Promise<Array<{ source_type: string; source_id: number; score: number }>> {
  const queryVec = await generateEmbedding(env, query)

  const sql = sourceType
    ? `SELECT source_type, source_id, vector FROM embeddings WHERE source_type = ?`
    : `SELECT source_type, source_id, vector FROM embeddings`

  const stmt = sourceType ? env.DB.prepare(sql).bind(sourceType) : env.DB.prepare(sql)
  const result = await stmt.all<{ source_type: string; source_id: number; vector: string }>()

  const scored = result.results.map(row => ({
    source_type: row.source_type,
    source_id: row.source_id,
    score: cosineSimilarity(queryVec, JSON.parse(row.vector)),
  }))

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}

export async function recall(
  env: Env,
  query: string,
  limit: number = 8
): Promise<Array<{ content: string; source: string; created_at: string; score: number }>> {
  const matches = await searchMemory(env, query, limit, 'observation')

  if (matches.length === 0) return []

  const ids = matches.map(m => m.source_id)
  const scoreMap = new Map(matches.map(m => [m.source_id, m.score]))

  const placeholders = ids.map(() => '?').join(',')
  const result = await env.DB.prepare(
    `SELECT id, content, source, created_at FROM observations WHERE id IN (${placeholders})`
  ).bind(...ids).all<ObservationRow>()

  return result.results.map(row => ({
    content: row.content,
    source: row.source,
    created_at: row.created_at,
    score: scoreMap.get(row.id) || 0,
  })).sort((a, b) => b.score - a.score)
}

// Ensure the "recent" model exists
export async function ensureRecentModel(env: Env): Promise<void> {
  const existing = await getModel(env, 'recent')
  if (!existing) {
    await createModel(env, 'recent', 'Rolling window of recent activity across all models')
  }
}
