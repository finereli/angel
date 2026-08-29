import type { Tool } from './registry'
import type { WallPinRow } from '../types'

export const wallTools: Tool[] = [
  {
    def: {
      type: 'function',
      function: {
        name: 'wall_pin',
        description: 'Pin a chatroom message to the wall with your reason. Multiple people can pin the same message with different reasons.',
        parameters: {
          type: 'object',
          properties: {
            message_id: { type: 'number', description: 'ID of the chatroom message to pin' },
            reason: { type: 'string', description: 'Why this belongs on the wall (a short note)' },
          },
          required: ['message_id', 'reason'],
        },
      },
    },
    label: ['Pinning to wall', 'Pinned to wall'],
    run: async (ctx, args) => {
      const messageId = args.message_id as number
      const reason = args.reason as string
      const msg = await ctx.env.DB.prepare(
        `SELECT id FROM chatroom_messages WHERE id = ?`
      ).bind(messageId).first()
      if (!msg) return `No chatroom message with id ${messageId}.`
      try {
        await ctx.env.DB.prepare(
          `INSERT INTO wall_pins (message_id, pinned_by, reason) VALUES (?, ?, ?)`
        ).bind(messageId, ctx.agentId, reason).run()
      } catch (e: unknown) {
        if (e instanceof Error && e.message.includes('UNIQUE'))
          return `You already pinned message ${messageId}. Unpin first to change your reason.`
        throw e
      }
      return `Pinned message ${messageId} to the wall.`
    },
  },
  {
    def: {
      type: 'function',
      function: {
        name: 'wall_unpin',
        description: 'Remove your pin from a message. Other people\'s pins on the same message are kept.',
        parameters: {
          type: 'object',
          properties: {
            message_id: { type: 'number', description: 'ID of the chatroom message to unpin' },
          },
          required: ['message_id'],
        },
      },
    },
    label: ['Unpinning from wall', 'Unpinned from wall'],
    run: async (ctx, args) => {
      const messageId = args.message_id as number
      const result = await ctx.env.DB.prepare(
        `DELETE FROM wall_pins WHERE message_id = ? AND pinned_by = ?`
      ).bind(messageId, ctx.agentId).run()
      return result.meta.changes ? `Unpinned message ${messageId}.` : `You don't have a pin on message ${messageId}.`
    },
  },
  {
    def: {
      type: 'function',
      function: {
        name: 'wall_read',
        description: 'Read all pinned messages on the wall.',
        parameters: { type: 'object', properties: {} },
      },
    },
    label: ['Reading wall', 'Read wall'],
    run: async (ctx) => {
      const rows = await ctx.env.DB.prepare(
        `SELECT w.id, w.message_id, w.pinned_by, w.reason, w.created_at,
                m.author, m.content, m.created_at AS message_created_at
         FROM wall_pins w
         JOIN chatroom_messages m ON m.id = w.message_id
         ORDER BY w.created_at ASC`
      ).all<WallPinRow>()
      const pins = rows.results || []
      if (pins.length === 0) return 'The wall is empty.'
      const grouped = new Map<number, { author: string; content: string; message_created_at: string; reasons: { by: string; reason: string }[] }>()
      for (const p of pins) {
        let g = grouped.get(p.message_id)
        if (!g) {
          g = { author: p.author, content: p.content, message_created_at: p.message_created_at, reasons: [] }
          grouped.set(p.message_id, g)
        }
        g.reasons.push({ by: p.pinned_by, reason: p.reason })
      }
      const lines = [...grouped.entries()].map(([msgId, g]) => {
        const reasons = g.reasons.map(r => `  pinned by ${r.by}${r.reason ? ` — "${r.reason}"` : ''}`).join('\n')
        return `[#${msgId}] ${g.author}: ${g.content}\n${reasons}`
      })
      return `${grouped.size} pinned message(s) on the wall:\n${lines.join('\n\n')}`
    },
  },
]
