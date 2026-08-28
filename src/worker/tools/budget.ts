import type { Tool } from './registry'
import { getModel } from '../llm'

export const budgetTools: Tool[] = [
  {
    def: {
      type: 'function',
      function: {
        name: 'check_budget',
        description: 'Check the remaining API budget (credits and usage) on the shared OpenRouter key. Call before expensive operations.',
        parameters: { type: 'object', properties: {} },
      },
    },
    label: ['Checking budget', 'Checked budget'],
    run: async (ctx) => {
      const res = await fetch('https://openrouter.ai/api/v1/auth/key', {
        headers: { 'Authorization': `Bearer ${ctx.env.OPENROUTER_API_KEY}` },
      })
      if (!res.ok) return `OpenRouter API error ${res.status}: ${await res.text()}`
      const data = await res.json() as {
        data?: {
          label?: string
          usage?: number
          limit?: number | null
          is_free_tier?: boolean
          rate_limit?: { requests?: number; interval?: string }
        }
      }
      const k = data.data
      if (!k) return 'No key data returned.'

      const used = k.usage ?? 0
      const limit = k.limit
      const remaining = limit != null ? limit - used : null
      const model = getModel(ctx.env)

      const lines = [
        `Model: ${model}`,
        `Credits used: $${used.toFixed(4)}`,
        limit != null
          ? `Credit limit: $${limit.toFixed(4)}`
          : 'Credit limit: unlimited',
        remaining != null
          ? `Remaining: $${remaining.toFixed(4)}`
          : 'Remaining: unlimited',
      ]
      if (k.is_free_tier) lines.push('Note: free tier (rate-limited)')
      if (k.rate_limit) {
        lines.push(`Rate limit: ${k.rate_limit.requests} requests / ${k.rate_limit.interval}`)
      }
      return lines.join('\n')
    },
  },
]
