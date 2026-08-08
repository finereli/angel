import type { Env, ShortTermRow } from './types'
import { chatCompletion } from './llm'

const GROUP_SIZE = 5

// Render the short-term pyramid for conversation start context
export async function renderShortTermPyramid(env: Env): Promise<string> {
  const tiers = await env.DB.prepare(
    `SELECT * FROM short_term ORDER BY tier ASC, pair_start DESC`
  ).all<ShortTermRow>()

  if (tiers.results.length === 0) return ''

  const byTier = new Map<number, ShortTermRow[]>()
  for (const row of tiers.results) {
    const list = byTier.get(row.tier) || []
    list.push(row)
    byTier.set(row.tier, list)
  }

  const parts = ['# Cross-conversation continuity']
  for (const [tier, rows] of [...byTier.entries()].sort((a, b) => b[0] - a[0])) {
    if (tier === 0) {
      parts.push('## Recent exchanges (verbatim)')
    } else {
      parts.push(`## Tier ${tier} summary`)
    }
    for (const row of rows.slice(0, GROUP_SIZE)) {
      parts.push(row.content)
    }
  }

  return parts.join('\n\n')
}

// Build missing summaries for the short-term pyramid
export async function buildShortTermSummaries(env: Env): Promise<void> {
  // Count total message pairs across all conversations
  const pairCount = await env.DB.prepare(
    `SELECT COUNT(*) / 2 as c FROM messages WHERE role IN ('user', 'assistant')`
  ).first<{ c: number }>()

  const totalPairs = pairCount?.c || 0
  if (totalPairs === 0) return

  // Tier 0: last GROUP_SIZE pairs verbatim
  const recentMessages = await env.DB.prepare(
    `SELECT role, content, created_at FROM messages
     WHERE role IN ('user', 'assistant')
     ORDER BY id DESC LIMIT ?`
  ).bind(GROUP_SIZE * 2).all<{ role: string; content: string; created_at: string }>()

  // Clear and rebuild tier 0
  await env.DB.prepare(`DELETE FROM short_term WHERE tier = 0`).run()

  const pairs = []
  const msgs = recentMessages.results.reverse()
  for (let i = 0; i < msgs.length - 1; i += 2) {
    if (msgs[i].role === 'user' && msgs[i + 1]?.role === 'assistant') {
      pairs.push({
        content: `User: ${truncate(msgs[i].content, 500)}\nAssistant: ${truncate(msgs[i + 1].content, 500)}`,
        created_at: msgs[i].created_at,
      })
    }
  }

  for (let i = 0; i < pairs.length; i++) {
    await env.DB.prepare(
      `INSERT INTO short_term (tier, content, pair_start, pair_end) VALUES (0, ?, ?, ?)`
    ).bind(pairs[i].content, totalPairs - pairs.length + i, totalPairs - pairs.length + i).run()
  }

  // Higher tiers: summarize groups of GROUP_SIZE from the tier below
  for (let tier = 1; tier <= 3; tier++) {
    const existing = await env.DB.prepare(
      `SELECT COUNT(*) as c FROM short_term WHERE tier = ?`
    ).bind(tier).first<{ c: number }>()

    const lowerTier = await env.DB.prepare(
      `SELECT * FROM short_term WHERE tier = ? ORDER BY pair_start ASC`
    ).bind(tier - 1).all<ShortTermRow>()

    if (lowerTier.results.length >= GROUP_SIZE && (existing?.c || 0) === 0) {
      const batch = lowerTier.results.slice(0, GROUP_SIZE)
      const content = batch.map(r => r.content).join('\n\n---\n\n')

      const summary = await summarizePairs(env, content, tier)

      await env.DB.prepare(
        `INSERT INTO short_term (tier, content, pair_start, pair_end) VALUES (?, ?, ?, ?)`
      ).bind(
        tier,
        summary,
        batch[0].pair_start,
        batch[batch.length - 1].pair_end
      ).run()
    }
  }
}

async function summarizePairs(env: Env, content: string, tier: number): Promise<string> {
  const result = await chatCompletion(env, [
    {
      role: 'system',
      content: `Compress these conversation exchanges into a tier-${tier} summary for cross-conversation continuity. Capture the key topics, decisions, emotional texture, and anything that would help you pick up where you left off. Write naturally, in your own voice.`,
    },
    { role: 'user', content },
  ], { temperature: 0.3, max_tokens: 1024 })

  return result.content || ''
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '...'
}
