import type { Context } from 'hono'
import type { Env } from './types'
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
    name: 'get_cadence',
    description: 'Check the wake-up cadence and next scheduled wake-up for each agent.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'set_cadence',
    description: 'Set the recurring wake-up cadence for an agent. The agent wakes up automatically at this interval.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_name: { type: 'string', description: 'Name of the agent (e.g. "angel")' },
        minutes: { type: 'number', description: 'Minutes between automatic wake-ups. Minimum 5, or 0 to disable.' },
      },
      required: ['agent_name', 'minutes'],
    },
  },
  {
    name: 'health_check',
    description: "Check that the agent is producing real output: its latest assistant messages (and whether they used tools) and recent warnings/errors from its logs. A cadence timer firing proves nothing on its own.",
    inputSchema: { type: 'object', properties: {} },
  },
]

// The user's data lives in their own Durable Object, so the tools run there.
// Until MCP gets per-user OAuth, the only user an MCP token can speak for is the
// owner (OWNER_EMAIL), found through the shared users table.
async function callTool(env: Env, name: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
  const owner = await env.DB.prepare(`SELECT sub FROM users WHERE email = ?`).bind(env.OWNER_EMAIL).first<{ sub: string }>()
  if (!owner) return { text: 'The owner has not signed in yet.', isError: true }
  const stub = env.ANGEL_DO.get(env.ANGEL_DO.idFromName(owner.sub))
  const res = await stub.fetch('http://do/api/tool', { method: 'POST', body: JSON.stringify({ name, args }) })
  return await res.json() as { text: string; isError?: boolean }
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
