import type { Tool } from './registry'

export const chatroomTools: Tool[] = [
  {
    def: {
      type: 'function',
      function: {
        name: 'chatroom_post',
        description: 'Post a message to the shared chatroom. Other agents will see it next time they check in.',
        parameters: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'The message to post' },
          },
          required: ['message'],
        },
      },
    },
    label: ['Posting to chatroom', 'Posted to chatroom'],
    run: async (ctx, args) => {
      const msg = args.message as string
      await ctx.env.DB.prepare(
        `INSERT INTO chatroom_messages (author, content) VALUES (?, ?)`
      ).bind(ctx.agentId, msg).run()
      return 'Posted.'
    },
  },
  {
    def: {
      type: 'function',
      function: {
        name: 'chatroom_read',
        description: 'Read chatroom messages. Returns everything since a timestamp (ISO 8601), or the last 50 messages if no timestamp given.',
        parameters: {
          type: 'object',
          properties: {
            since: { type: 'string', description: 'ISO 8601 timestamp - return messages after this time. Omit for the latest 50.' },
          },
        },
      },
    },
    label: ['Reading chatroom', 'Read chatroom'],
    run: async (ctx, args) => {
      const since = (args.since as string | undefined)?.replace('T', ' ').replace('Z', '')
      let rows
      if (since) {
        rows = await ctx.env.DB.prepare(
          `SELECT id, author, content, created_at FROM chatroom_messages WHERE created_at > ? ORDER BY created_at ASC LIMIT 200`
        ).bind(since).all<{ id: number; author: string; content: string; created_at: string }>()
      } else {
        rows = await ctx.env.DB.prepare(
          `SELECT id, author, content, created_at FROM chatroom_messages ORDER BY created_at DESC LIMIT 50`
        ).all<{ id: number; author: string; content: string; created_at: string }>()
        if (rows.results) rows.results.reverse()
      }
      const messages = rows.results || []
      if (messages.length === 0) return since ? 'No new messages since that time.' : 'The chatroom is empty.'
      const lines = messages.map(m => `[${m.created_at}] ${m.author}: ${m.content}`)
      const header = since ? `${messages.length} message(s) since ${since}:` : `Last ${messages.length} message(s):`
      return `${header}\n${lines.join('\n')}`
    },
  },
  {
    def: {
      type: 'function',
      function: {
        name: 'chatroom_search',
        description: 'Search chatroom history by keyword. Returns messages matching the query, newest first.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search term (case-insensitive, matches anywhere in message content or author)' },
            limit: { type: 'number', description: 'Max results to return (default 20, max 100)' },
          },
          required: ['query'],
        },
      },
    },
    label: ['Searching chatroom', 'Searched chatroom'],
    run: async (ctx, args) => {
      const query = (args.query as string || '').trim()
      if (!query) return 'Empty search query.'
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100)
      const pattern = `%${query}%`
      const rows = await ctx.env.DB.prepare(
        `SELECT id, author, content, created_at FROM chatroom_messages
         WHERE content LIKE ? OR author LIKE ?
         ORDER BY created_at DESC LIMIT ?`
      ).bind(pattern, pattern, limit).all<{ id: number; author: string; content: string; created_at: string }>()
      const messages = rows.results || []
      if (messages.length === 0) return `No messages matching "${query}".`
      messages.reverse()
      const lines = messages.map(m => `[#${m.id}] ${m.author} (${m.created_at}): ${m.content}`)
      return `${messages.length} result(s) for "${query}":\n${lines.join('\n')}`
    },
  },
]
