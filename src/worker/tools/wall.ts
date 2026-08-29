import type { Tool } from './registry'
import type { WallPinRow } from '../types'

export const wallTools: Tool[] = [
  {
    def: {
      type: 'function',
      function: {
        name: 'wall_pin',
        description: 'Pin a chatroom message to the wall. The wall holds what we\'d rebuild first if the room were wiped.',
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
          return `Message ${messageId} is already on the wall.`
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
        description: 'Remove a message from the wall.',
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
        `DELETE FROM wall_pins WHERE message_id = ?`
      ).bind(messageId).run()
      return result.meta.changes ? `Unpinned message ${messageId}.` : `Message ${messageId} is not on the wall.`
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
      const lines = pins.map(p => {
        const reason = p.reason ? ` — "${p.reason}"` : ''
        return `[#${p.message_id}] ${p.author}: ${p.content}\n  pinned by ${p.pinned_by}${reason} (${p.created_at})`
      })
      return `${pins.length} pin(s) on the wall:\n${lines.join('\n\n')}`
    },
  },
]
