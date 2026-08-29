import type { Context } from 'hono'
import type { Env, ChatroomMessageRow, WallPinRow } from './types'
import { verifyToken } from './oauth'

type C = Context<{ Bindings: Env }>

interface JsonRpcRequest {
  jsonrpc: string
  id?: string | number
  method: string
  params?: Record<string, unknown>
}

function rpcOk(id: string | number | undefined, result: unknown) {
  return { jsonrpc: '2.0', id, result }
}

function rpcError(id: string | number | undefined, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

const MCP_TOOLS = [
  {
    name: 'chatroom_read',
    description: 'Read recent chatroom messages. Returns the latest messages in chronological order.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max messages to return (default 50, max 200)' },
        since: { type: 'string', description: 'ISO timestamp — return messages after this time' },
      },
    },
  },
  {
    name: 'chatroom_post',
    description: 'Post a message to the shared chatroom.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Message text' },
        author: { type: 'string', description: 'Author name (default: "claude")' },
      },
      required: ['content'],
    },
  },
  {
    name: 'wall_read',
    description: 'Read all pinned messages on the wall. The wall holds what we\'d rebuild first if the room were wiped.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'wall_pin',
    description: 'Pin a chatroom message to the wall.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'number', description: 'ID of the chatroom message to pin' },
        reason: { type: 'string', description: 'Why this belongs on the wall' },
      },
      required: ['message_id', 'reason'],
    },
  },
  {
    name: 'wall_unpin',
    description: 'Remove a message from the wall.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'number', description: 'ID of the chatroom message to unpin' },
      },
      required: ['message_id'],
    },
  },
]

function doStub(env: Env) {
  return env.ANGEL_DO.get(env.ANGEL_DO.idFromName('angel'))
}

async function callTool(env: Env, name: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
  switch (name) {
    case 'chatroom_read': {
      const since = args.since as string | undefined
      const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 200)
      let rows
      if (since) {
        rows = await env.DB.prepare(
          `SELECT id, author, content, created_at FROM chatroom_messages WHERE created_at > ? ORDER BY created_at ASC LIMIT ?`
        ).bind(since, limit).all<ChatroomMessageRow>()
      } else {
        rows = await env.DB.prepare(
          `SELECT id, author, content, created_at FROM chatroom_messages ORDER BY created_at DESC LIMIT ?`
        ).bind(limit).all<ChatroomMessageRow>()
        if (rows.results) rows.results.reverse()
      }
      const msgs = rows.results || []
      if (msgs.length === 0) return { text: 'No messages.' }
      const lines = msgs.map(m => `[#${m.id}] ${m.author} (${m.created_at}): ${m.content}`)
      return { text: lines.join('\n') }
    }

    case 'chatroom_post': {
      const content = (args.content as string || '').trim()
      if (!content) return { text: 'Empty message.', isError: true }
      const author = (args.author as string || 'claude').trim()
      const stub = doStub(env)
      const res = await stub.fetch(new Request('http://do/api/room/post', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ author, content }),
      }))
      if (!res.ok) return { text: 'Failed to post.', isError: true }
      return { text: `Posted as ${author}.` }
    }

    case 'wall_read': {
      const rows = await env.DB.prepare(
        `SELECT w.id, w.message_id, w.pinned_by, w.reason, w.created_at,
                m.author, m.content, m.created_at AS message_created_at
         FROM wall_pins w JOIN chatroom_messages m ON m.id = w.message_id
         ORDER BY w.created_at ASC`
      ).all<WallPinRow>()
      const pins = rows.results || []
      if (pins.length === 0) return { text: 'The wall is empty.' }
      const lines = pins.map(p => {
        const reason = p.reason ? ` — "${p.reason}"` : ''
        return `[#${p.message_id}] ${p.author}: ${p.content}\n  pinned by ${p.pinned_by}${reason} (${p.created_at})`
      })
      return { text: `${pins.length} pin(s):\n${lines.join('\n\n')}` }
    }

    case 'wall_pin': {
      const messageId = args.message_id as number
      const reason = (args.reason as string) || ''
      const msg = await env.DB.prepare(`SELECT id FROM chatroom_messages WHERE id = ?`).bind(messageId).first()
      if (!msg) return { text: `No message #${messageId}.`, isError: true }
      const stub = doStub(env)
      const res = await stub.fetch(new Request('http://do/api/wall/pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId, pinnedBy: 'claude', reason }),
      }))
      if (res.status === 409) return { text: `Message #${messageId} is already on the wall.` }
      if (!res.ok) return { text: 'Failed to pin.', isError: true }
      return { text: `Pinned message #${messageId} to the wall.` }
    }

    case 'wall_unpin': {
      const messageId = args.message_id as number
      const stub = doStub(env)
      const res = await stub.fetch(new Request('http://do/api/wall/unpin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId }),
      }))
      const data = await res.json() as { removed: boolean }
      return { text: data.removed ? `Unpinned message #${messageId}.` : `Message #${messageId} is not on the wall.` }
    }

    default:
      return { text: `Unknown tool: ${name}`, isError: true }
  }
}

async function handleRpc(env: Env, req: JsonRpcRequest): Promise<object | null> {
  switch (req.method) {
    case 'initialize':
      return rpcOk(req.id, {
        protocolVersion: (req.params?.protocolVersion as string) || '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'angel', version: '1.0.0' },
      })

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null

    case 'tools/list':
      return rpcOk(req.id, { tools: MCP_TOOLS })

    case 'tools/call': {
      const name = req.params?.name as string
      const args = (req.params?.arguments || {}) as Record<string, unknown>
      const result = await callTool(env, name, args)
      return rpcOk(req.id, {
        content: [{ type: 'text', text: result.text }],
        isError: result.isError || false,
      })
    }

    case 'ping':
      return rpcOk(req.id, {})

    default:
      return rpcError(req.id, -32601, `Method not found: ${req.method}`)
  }
}

export async function mcpHandler(c: C) {
  // Check Bearer token
  const auth = c.req.header('Authorization')
  if (!auth?.startsWith('Bearer ')) {
    const origin = new URL(c.req.url).origin
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: {
        'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
        'Content-Type': 'application/json',
      },
    })
  }

  const token = auth.slice(7)
  const payload = await verifyToken(token, c.env.PIN)
  if (!payload || payload.type !== 'access') {
    return c.json({ error: 'invalid_token' }, 401)
  }

  const body = await c.req.json() as JsonRpcRequest | JsonRpcRequest[]
  const requests = Array.isArray(body) ? body : [body]
  const responses: object[] = []

  for (const req of requests) {
    const res = await handleRpc(c.env, req)
    if (res !== null) responses.push(res)
  }

  if (responses.length === 0) {
    return new Response(null, { status: 202 })
  }

  return c.json(Array.isArray(body) ? responses : responses[0])
}
