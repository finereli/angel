import type { Tool } from './registry'

export const wakeupTools: Tool[] = [
  {
    def: {
      type: 'function',
      function: {
        name: 'schedule_wakeup',
        description:
          'Schedule a future wake-up for yourself. You will receive a system message in your DM at the scheduled time and get a chance to act. ' +
          'Only one wake-up can be pending at a time; calling again replaces the previous one. ' +
          'Use this to check in on things, follow up on conversations, or do periodic work.',
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
        name: 'cancel_wakeup',
        description: 'Cancel your pending wake-up, if any.',
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
]
