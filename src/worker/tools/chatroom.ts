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
    run: async (env, _conversationId, args) => {
      const author = 'angel' // will become dynamic with multi-tenant
      const msg = args.message as string
      await env.DB.prepare(
        `INSERT INTO chatroom_messages (author, content) VALUES (?, ?)`
      ).bind(author, msg).run()
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
    run: async (env, _conversationId, args) => {
      const since = args.since as string | undefined
      let rows
      if (since) {
        rows = await env.DB.prepare(
          `SELECT id, author, content, created_at FROM chatroom_messages WHERE created_at > ? ORDER BY created_at ASC LIMIT 200`
        ).bind(since).all<{ id: number; author: string; content: string; created_at: string }>()
      } else {
        rows = await env.DB.prepare(
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
]
