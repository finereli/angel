import type { Tool } from './registry'

export const wakeupTools: Tool[] = [
  {
    def: {
      type: 'function',
      function: {
        name: 'schedule_wakeup',
        description:
          'Schedule a one-off wake-up for yourself. You will receive a system message in your DM at the scheduled time and get a chance to act. ' +
          'Only one wake-up can be pending at a time; calling again replaces the previous one. ' +
          'Note: if you have a cadence set, you\'ll wake up at least that often automatically — use this only for extra, earlier check-ins.',
        parameters: {
          type: 'object',
          properties: {
            minutes: {
              type: 'number',
              description: 'Minutes from now to wake up. Minimum 1.',
            },
            reason: {
              type: 'string',
              description: 'Why you are waking up — this will be included in the wake-up message you receive.',
            },
          },
          required: ['minutes'],
        },
      },
    },
    label: ['Scheduling wake-up', 'Scheduled wake-up'],
    run: async (ctx, args) => {
      const minutes = Math.max(1, Math.round(Number(args.minutes) || 1))
      const reason = (args.reason as string) || ''
      const wakeAt = new Date(Date.now() + minutes * 60_000).toISOString()

      await ctx.env.DB.prepare(
        `INSERT INTO agent_wakeups (agent_id, wake_at, reason)
         VALUES (?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET wake_at = excluded.wake_at, reason = excluded.reason, created_at = datetime('now')`
      ).bind(ctx.agentId, wakeAt, reason || null).run()

      return `Wake-up scheduled for ${minutes} minute${minutes === 1 ? '' : 's'} from now (${wakeAt}).${reason ? ` Reason: ${reason}` : ''}`
    },
  },
  {
    def: {
      type: 'function',
      function: {
        name: 'check_wakeup',
        description: 'Check your pending wake-up and cadence settings.',
        parameters: { type: 'object', properties: {} },
      },
    },
    label: ['Checking wake-up', 'Checked wake-up'],
    run: async (ctx) => {
      const row = await ctx.env.DB.prepare(
        `SELECT wake_at, reason FROM agent_wakeups WHERE agent_id = ?`
      ).bind(ctx.agentId).first<{ wake_at: string; reason: string | null }>()

      const agent = await ctx.env.DB.prepare(
        `SELECT cadence_minutes FROM agents WHERE id = ?`
      ).bind(ctx.agentId).first<{ cadence_minutes: number | null }>()

      const parts: string[] = []

      if (agent?.cadence_minutes) {
        parts.push(`Cadence: every ${agent.cadence_minutes} minutes (you'll wake up automatically at this interval).`)
      } else {
        parts.push('Cadence: not set (you only wake up from manual schedule_wakeup calls).')
      }

      if (row) {
        const wake = new Date(row.wake_at.endsWith('Z') ? row.wake_at : row.wake_at + 'Z')
        const mins = Math.max(0, Math.round((wake.getTime() - Date.now()) / 60_000))
        const timeStr = wake.toISOString()
        if (mins <= 0) {
          parts.push(`Next wake-up: due now (${timeStr}).${row.reason ? ` Reason: ${row.reason}` : ''}`)
        } else {
          parts.push(`Next wake-up: in ${mins} minute${mins === 1 ? '' : 's'} (${timeStr}).${row.reason ? ` Reason: ${row.reason}` : ''}`)
        }
      } else {
        parts.push('Next wake-up: none scheduled.')
      }

      return parts.join('\n')
    },
  },
  {
    def: {
      type: 'function',
      function: {
        name: 'cancel_wakeup',
        description: 'Cancel your pending wake-up, if any. Does not affect your cadence — the next cadence-driven wakeup will still fire.',
        parameters: { type: 'object', properties: {} },
      },
    },
    label: ['Cancelling wake-up', 'Cancelled wake-up'],
    run: async (ctx) => {
      const result = await ctx.env.DB.prepare(
        `DELETE FROM agent_wakeups WHERE agent_id = ?`
      ).bind(ctx.agentId).run()
      return result.meta.changes > 0
        ? 'Wake-up cancelled.'
        : 'No pending wake-up to cancel.'
    },
  },
  {
    def: {
      type: 'function',
      function: {
        name: 'set_cadence',
        description:
          'Set your recurring wake-up cadence. Once set, you\'ll automatically wake up at this interval — ' +
          'no need to call schedule_wakeup each time. Set to 0 to disable cadence (back to manual-only).',
        parameters: {
          type: 'object',
          properties: {
            minutes: {
              type: 'number',
              description: 'Minutes between automatic wake-ups. Minimum 5, or 0 to disable.',
            },
          },
          required: ['minutes'],
        },
      },
    },
    label: ['Setting cadence', 'Set cadence'],
    run: async (ctx, args) => {
      const raw = Math.round(Number(args.minutes) || 0)
      if (raw === 0) {
        await ctx.env.DB.prepare(
          `UPDATE agents SET cadence_minutes = NULL WHERE id = ?`
        ).bind(ctx.agentId).run()
        return 'Cadence disabled. You\'ll only wake up from manual schedule_wakeup calls now.'
      }
      const minutes = Math.max(5, raw)
      await ctx.env.DB.prepare(
        `UPDATE agents SET cadence_minutes = ? WHERE id = ?`
      ).bind(minutes, ctx.agentId).run()
      return `Cadence set to every ${minutes} minutes. You'll wake up automatically at this interval.`
    },
  },
  {
    def: {
      type: 'function',
      function: {
        name: 'get_cadence',
        description: 'Check your current cadence setting.',
        parameters: { type: 'object', properties: {} },
      },
    },
    label: ['Checking cadence', 'Checked cadence'],
    run: async (ctx) => {
      const row = await ctx.env.DB.prepare(
        `SELECT cadence_minutes FROM agents WHERE id = ?`
      ).bind(ctx.agentId).first<{ cadence_minutes: number | null }>()
      if (!row || !row.cadence_minutes) return 'No cadence set. You only wake up from manual schedule_wakeup calls.'
      return `Your cadence is every ${row.cadence_minutes} minutes.`
    },
  },
]
