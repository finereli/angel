import type { Tool } from './registry'

export const dmTools: Tool[] = [
  {
    def: {
      type: 'function',
      function: {
        name: 'dm_read',
        description: 'Read your direct messages with Eli. Returns recent DMs or messages since a timestamp.',
        parameters: {
          type: 'object',
          properties: {
            since: { type: 'string', description: 'ISO 8601 timestamp - return messages after this time. Omit for the latest 50.' },
          },
        },
      },
    },
    label: ['Reading DMs', 'Read DMs'],
    run: async (ctx, args) => {
      const since = (args.since as string | undefined)?.replace('T', ' ').replace('Z', '')
      let rows
      if (since) {
        rows = await ctx.env.DB.prepare(
          `SELECT id, author, content, created_at FROM dm_messages WHERE agent_id = ? AND created_at > ? ORDER BY created_at ASC LIMIT 200`
        ).bind(ctx.agentId, since).all<{ id: number; author: string; content: string; created_at: string }>()
      } else {
        rows = await ctx.env.DB.prepare(
          `SELECT id, author, content, created_at FROM dm_messages WHERE agent_id = ? ORDER BY created_at DESC LIMIT 50`
        ).bind(ctx.agentId).all<{ id: number; author: string; content: string; created_at: string }>()
        if (rows.results) rows.results.reverse()
      }
      const messages = rows.results || []
      if (messages.length === 0) return since ? 'No new DMs since that time.' : 'No DMs yet.'
      const lines = messages.map(m => `[${m.created_at}] ${m.author}: ${m.content}`)
      const header = since ? `${messages.length} DM(s) since ${since}:` : `Last ${messages.length} DM(s):`
      return `${header}\n${lines.join('\n')}`
    },
  },
  {
    def: {
      type: 'function',
      function: {
        name: 'dm_send',
        description: 'Send a direct message to Eli. This goes to your private DM channel with him, not the chatroom.',
        parameters: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'The message to send' },
          },
          required: ['message'],
        },
      },
    },
    label: ['Sending DM', 'Sent DM'],
    run: async (ctx, args) => {
      const content = args.message as string
      const id = ctx.env.ANGEL_DO.idFromName('angel')
      const stub = ctx.env.ANGEL_DO.get(id)
      await stub.fetch(new Request('http://do/api/dm/post', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: ctx.agentId, author: ctx.agentId, content }),
      }))
      return 'DM sent.'
    },
  },
]
