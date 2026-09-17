import type { Tool } from './registry'

// The shape of OpenRouter's /api/v1/auth/key response, as far as budget goes.
// The tool reports these fields as-is rather than interpreting the limit's scope.
export interface KeyInfo {
  label?: string
  is_management_key?: boolean
  is_provisioning_key?: boolean
  limit?: number | null
  limit_reset?: string | null
  limit_remaining?: number | null
  include_byok_in_limit?: boolean
  usage?: number // lifetime on this key
  usage_daily?: number
  usage_weekly?: number
  usage_monthly?: number
  byok_usage?: number
  is_free_tier?: boolean
  expires_at?: string | null
  allowed_data_regions?: string[]
  free_model_daily_requests?: { used?: number; limit?: number; remaining?: number }
  rate_limit?: { requests?: number; interval?: string; note?: string }
}

// The API gives the reset cadence, not the moment. OpenRouter resets daily at
// midnight UTC, weekly on Monday, monthly on the 1st (per its dashboard), so we
// can state when the next one lands.
export function nextReset(period: string | null | undefined, now: Date): string | null {
  const d = new Date(now)
  d.setUTCHours(0, 0, 0, 0)
  if (period === 'daily') d.setUTCDate(d.getUTCDate() + 1)
  else if (period === 'weekly') {
    const day = d.getUTCDay() // 0 Sun .. 1 Mon
    d.setUTCDate(d.getUTCDate() + (((8 - day) % 7) || 7))
  } else if (period === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1, 1)
  else return null
  return d.toISOString()
}

// Pure formatter (tested in budget.test.ts). Reports the raw fields - allocation,
// reset cadence, remaining, current spend - without claiming the limit's scope.
export function formatBudget(k: KeyInfo, now: Date = new Date()): string {
  const money = (n: number | null | undefined) => (n == null ? 'unknown' : `$${n.toFixed(4)}`)
  const lines: string[] = []

  if (k.label) lines.push(`Key: ${k.label}`)
  lines.push(`Allocation: ${k.limit != null ? money(k.limit) : 'none set'}`)
  if (k.limit_reset) lines.push(`Cadence: ${k.limit_reset}`)
  if (k.limit_remaining != null) lines.push(`Remaining: ${money(k.limit_remaining)}`)
  const reset = nextReset(k.limit_reset, now)
  if (reset) lines.push(`Next reset: ${reset}`)
  if (k.include_byok_in_limit) lines.push('(BYOK usage counts toward the limit)')

  lines.push(`Spent today: ${money(k.usage_daily)}`)
  lines.push(`Spent this week: ${money(k.usage_weekly)}`)
  lines.push(`Spent this month: ${money(k.usage_monthly)}`)
  lines.push(`Lifetime on this key: ${money(k.usage)}`)
  if (k.byok_usage) lines.push(`BYOK lifetime: ${money(k.byok_usage)}`)

  if (k.allowed_data_regions?.length) lines.push(`Data regions: ${k.allowed_data_regions.join(', ')}`)
  if (k.free_model_daily_requests?.limit != null) {
    const f = k.free_model_daily_requests
    lines.push(`Free-model requests today: ${f.used ?? 0}/${f.limit} (${f.remaining ?? 0} left)`)
  }
  if (k.rate_limit && (k.rate_limit.requests ?? -1) >= 0) {
    lines.push(`Rate limit: ${k.rate_limit.requests} requests / ${k.rate_limit.interval}`)
  }
  if (k.is_free_tier) lines.push('Note: free tier')
  if (k.expires_at) lines.push(`Key expires: ${k.expires_at}`)
  return lines.join('\n')
}

export const budgetTools: Tool[] = [
  {
    def: {
      type: 'function',
      function: {
        name: 'check_budget',
        description:
          "Check the budget on the OpenRouter key you run on: allocation, reset cadence, remaining, and current spend. Read it as a snapshot - the allocation resets, so `Remaining` and the period's spend are the live numbers. Call it before expensive operations.",
        parameters: { type: 'object', properties: {} },
      },
    },
    label: ['Checking budget', 'Checked budget'],
    run: async (ctx) => {
      const res = await fetch('https://openrouter.ai/api/v1/auth/key', {
        headers: { 'Authorization': `Bearer ${ctx.env.OPENROUTER_API_KEY}` },
      })
      if (!res.ok) return `OpenRouter API error ${res.status}: ${await res.text()}`
      const data = await res.json() as { data?: KeyInfo }
      const k = data.data
      if (!k) return 'No key data returned.'
      return formatBudget(k)
    },
  },
]