import { describe, it, expect } from 'vitest'
import { formatBudget, nextReset } from './budget'

const NOW = new Date('2026-09-17T12:00:00Z') // a Thursday

// The old tool compared lifetime `usage` against the limit, so a resetting
// allocation showed as a negative "remaining". These lock in that the API's own
// fields are reported, and the next reset is derived from the cadence.
describe('formatBudget', () => {
  it('reports allocation, cadence, remaining, and current spend', () => {
    const out = formatBudget({
      label: 'angel',
      limit: 1,
      limit_reset: 'daily',
      limit_remaining: 0.42,
      usage: 9.13, // lifetime, far above the allocation
      usage_daily: 0.58,
      usage_weekly: 3.2,
      usage_monthly: 9.13,
    }, NOW)
    expect(out).toContain('Key: angel')
    expect(out).toContain('Allocation: $1.0000')
    expect(out).toContain('Cadence: daily')
    expect(out).toContain('Remaining: $0.4200')
    expect(out).toContain('Spent today: $0.5800')
    expect(out).not.toContain('-$')
  })

  it('computes the next reset from the cadence', () => {
    expect(nextReset('daily', NOW)).toBe('2026-09-18T00:00:00.000Z')
    expect(nextReset('weekly', NOW)).toBe('2026-09-21T00:00:00.000Z') // next Monday
    expect(nextReset('monthly', NOW)).toBe('2026-10-01T00:00:00.000Z')
    expect(nextReset(null, NOW)).toBeNull()
  })

  it('handles no allocation set', () => {
    const out = formatBudget({ limit: null, usage: 2 }, NOW)
    expect(out).toContain('Allocation: none set')
    expect(out).not.toContain('Remaining:')
  })
})