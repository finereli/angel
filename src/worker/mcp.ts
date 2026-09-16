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
]

function doStub(env: Env) {
  return env.ANGEL_DO.get(env.ANGEL_DO.idFromName('angel'))
}

async function callTool(env: Env, name: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
  switch (name) {
    case 'set_cadence': {
      const agentName = (args.agent_name as string || '').trim().toLowerCase()
      const raw = Math.round(Number(args.minutes) || 0)
      if (!agentName) return { text: 'agent_name is required.', isError: true }
      const agent = await env.DB.prepare(`SELECT id FROM agents WHERE lower(name) = ?`).bind(agentName).first<{ id: string }>()
      if (!agent) return { text: `No agent named "${agentName}".`, isError: true }
      if (raw === 0) {
        await env.DB.prepare(`UPDATE agents SET cadence_minutes = NULL WHERE id = ?`).bind(agent.id).run()
        return { text: `Cadence disabled for ${agentName}.` }
      }
      const minutes = Math.max(5, raw)
      await env.DB.prepare(`UPDATE agents SET cadence_minutes = ? WHERE id = ?`).bind(minutes, agent.id).run()
      // Ensure a wakeup is scheduled
      const existing = await env.DB.prepare(`SELECT agent_id FROM agent_wakeups WHERE agent_id = ?`).bind(agent.id).first()
      if (!existing) {
        const nextWake = new Date(Date.now() + minutes * 60_000).toISOString()
        await env.DB.prepare(
          `INSERT INTO agent_wakeups (agent_id, wake_at, reason) VALUES (?, ?, 'cadence check-in')`
        ).bind(agent.id, nextWake).run()
      }
      const stub = doStub(env)
      await stub.fetch(new Request('http://do/api/sync-alarm', { method: 'POST' }))
      return { text: `Cadence set to every ${minutes} minutes for ${agentName}.` }
    }

    case 'get_cadence': {
      const rows = await env.DB.prepare(
        `SELECT a.name, a.cadence_minutes, w.wake_at
         FROM agents a
         LEFT JOIN agent_wakeups w ON w.agent_id = a.id
         ORDER BY a.name`
      ).all<{ name: string; cadence_minutes: number | null; wake_at: string | null }>()
      const agents = rows.results || []
      if (agents.length === 0) return { text: 'No agents.' }
      const lines = agents.map(a => {
        const cadence = a.cadence_minutes ? `every ${a.cadence_minutes}min` : 'none'
        let next = 'no wakeup scheduled'
        if (a.wake_at) {
          const wake = new Date(a.wake_at.endsWith('Z') ? a.wake_at : a.wake_at + 'Z')
          const mins = Math.max(0, Math.round((wake.getTime() - Date.now()) / 60_000))
          next = mins <= 0 ? 'due now' : `in ${mins}min`
        }
        return `${a.name}: cadence=${cadence}, next=${next}`
      })
      return { text: lines.join('\n') }
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
