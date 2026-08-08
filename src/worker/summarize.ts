import type { Env } from './types'
import { chatCompletion } from './llm'
import {
  getAllModels, getUnsummarizedObservations, getSummariesForModel,
  saveSummary, updatePortrait, ensureRecentModel
} from './memory'

const BATCH_SIZE = 8
const TIER_0_BATCH = 5

export async function runConsolidation(env: Env): Promise<string> {
  await ensureRecentModel(env)
  const models = await getAllModels(env)
  const notes: string[] = []

  for (const model of models) {
    const result = await consolidateModel(env, model.id, model.name)
    if (result) notes.push(result)
  }

  return notes.length > 0
    ? `Consolidated ${notes.length} models: ${notes.join('; ')}`
    : 'No consolidation needed'
}

async function consolidateModel(env: Env, modelId: string, modelName: string): Promise<string | null> {
  // Tier 0: batch unsummarized observations
  const unsummarized = await getUnsummarizedObservations(env, modelId)
  if (unsummarized.length < TIER_0_BATCH) return null

  let tier0Count = 0
  for (let i = 0; i + TIER_0_BATCH <= unsummarized.length; i += TIER_0_BATCH) {
    const batch = unsummarized.slice(i, i + TIER_0_BATCH)
    const content = batch.map(o =>
      `[${o.created_at}] ${o.content}`
    ).join('\n\n')

    const summary = await compress(env, content, 0, modelName)
    await saveSummary(env, modelId, 0, summary, 'observation', batch.map(o => o.id))
    tier0Count++
  }

  // Higher tiers: batch tier-N summaries into tier-(N+1)
  for (let tier = 0; tier < 3; tier++) {
    const summaries = await getUnbatchedSummaries(env, modelId, tier)
    if (summaries.length < TIER_0_BATCH) continue

    for (let i = 0; i + TIER_0_BATCH <= summaries.length; i += TIER_0_BATCH) {
      const batch = summaries.slice(i, i + TIER_0_BATCH)
      const content = batch.map(s => s.content).join('\n\n---\n\n')

      const summary = await compress(env, content, tier + 1, modelName)
      await saveSummary(env, modelId, tier + 1, summary, 'summary', batch.map(s => s.id))
    }
  }

  // Synthesize portrait
  if (tier0Count > 0) {
    await synthesizePortrait(env, modelId, modelName)
  }

  return `${modelName}: ${tier0Count} tier-0 batches`
}

async function getUnbatchedSummaries(
  env: Env,
  modelId: string,
  tier: number
): Promise<Array<{ id: number; content: string }>> {
  const result = await env.DB.prepare(
    `SELECT s.id, s.content FROM summaries s
     LEFT JOIN summary_sources ss ON ss.source_type = 'summary' AND ss.source_id = s.id
     WHERE s.model_id = ? AND s.tier = ? AND ss.summary_id IS NULL
     ORDER BY s.created_at ASC`
  ).bind(modelId, tier).all<{ id: number; content: string }>()
  return result.results
}

async function compress(
  env: Env,
  content: string,
  tier: number,
  modelName: string
): Promise<string> {
  const tierLabel = tier === 0 ? 'raw observations' : `tier-${tier - 1} summaries`
  const prompt = `You are compressing ${tierLabel} for the "${modelName}" memory model into a tier-${tier} summary.

Preserve:
- Specific facts, names, dates, numbers
- Causal connections and turning points
- The emotional and relational texture
- What changed and why it matters

Drop:
- Redundancy across observations
- Procedural detail that doesn't carry meaning
- Generic statements that could apply to anyone

Write in your natural voice. This summary will be part of your own memory - it should read like something you'd want to remember, not like a report for someone else.`

  const result = await chatCompletion(env, [
    { role: 'system', content: prompt },
    { role: 'user', content },
  ], { temperature: 0.3, max_tokens: 2048 })

  return result.content || ''
}

async function synthesizePortrait(
  env: Env,
  modelId: string,
  modelName: string
): Promise<void> {
  const summaries = await getSummariesForModel(env, modelId)
  if (summaries.length === 0) return

  // Group by tier, take newest from each
  const byTier = new Map<number, string[]>()
  for (const s of summaries) {
    const list = byTier.get(s.tier) || []
    list.push(s.content)
    byTier.set(s.tier, list)
  }

  const parts: string[] = []
  for (const [tier, contents] of [...byTier.entries()].sort((a, b) => b[0] - a[0])) {
    parts.push(`## Tier ${tier}\n${contents.slice(0, 3).join('\n\n')}`)
  }

  // Also include recent unsummarized observations
  const recent = await getUnsummarizedObservations(env, modelId)
  if (recent.length > 0) {
    parts.push(`## Recent (unsummarized)\n${recent.slice(0, 10).map(o =>
      `[${o.created_at}] ${o.content}`
    ).join('\n\n')}`)
  }

  const prompt = `Synthesize everything below into a cohesive portrait of the "${modelName}" model. This is your own memory - write it as a living understanding, not a database dump.

Start with the broadest arc (highest tier summaries give the long view), then layer in recent detail. Prioritize:
- The current state of things and recent trajectory
- Key relationships, decisions, and unresolved tensions
- Specific facts that matter (names, dates, numbers)
- What you'd want to know if picking this up cold

Write naturally. First person is fine. Keep it under 500 words unless the model genuinely needs more.`

  const result = await chatCompletion(env, [
    { role: 'system', content: prompt },
    { role: 'user', content: parts.join('\n\n') },
  ], { temperature: 0.4, max_tokens: 2048 })

  if (result.content) {
    await updatePortrait(env, modelId, result.content)
  }
}
