// The cadence tools, run inside a user's Durable Object (where their agents and
// wake-ups live). The MCP server exposes them to external agents; see mcp.ts.
import type { Env } from './types'

export async function runCadenceTool(
  env: Env, name: string, args: Record<string, unknown>, syncAlarm: () => Promise<void>,
): Promise<{ text: string; isError?: boolean }> {
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
      await syncAlarm()
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

    case 'health_check': {
      const recent = await env.DB.prepare(
        `SELECT created_at, CASE WHEN parts LIKE '%"type":"tool"%' THEN 'tools' ELSE 'no tools' END AS tools, substr(content, 1, 120) AS preview
         FROM messages WHERE role = 'assistant' ORDER BY id DESC LIMIT 8`
      ).all<{ created_at: string; tools: string; preview: string }>()
      const logs = await env.DB.prepare(
        `SELECT created_at, level, event, substr(coalesce(detail, ''), 1, 160) AS detail
         FROM agent_logs WHERE level IN ('warn', 'error') ORDER BY id DESC LIMIT 10`
      ).all<{ created_at: string; level: string; event: string; detail: string }>()
      const replies = recent.results.length
        ? recent.results.map(r => `${r.created_at} [${r.tools}] ${r.preview.replace(/\s+/g, ' ')}`).join('\n')
        : 'none yet'
      const problems = logs.results.length
        ? logs.results.map(l => `${l.created_at} ${l.level} ${l.event}: ${l.detail}`).join('\n')
        : 'none'
      return { text: `Latest assistant messages:\n${replies}\n\nRecent warnings and errors:\n${problems}` }
    }

    default:
      return { text: `Unknown tool: ${name}`, isError: true }
  }
}
