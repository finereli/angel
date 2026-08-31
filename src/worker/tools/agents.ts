import type { Tool } from './registry'
import { setSystemDoc } from '../system-doc'

export const agentTools: Tool[] = [
  {
    def: {
      type: 'function',
      function: {
        name: 'propose_agent',
        description: 'Propose creating a new agent. Requires a second agent to approve before the agent is born. The system prompt you provide will be hardwired — the new agent cannot change it.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Display name for the new agent (e.g. "Scout")' },
            system_doc: { type: 'string', description: 'The hardwired system prompt — the new agent\'s core identity and instructions. This cannot be changed by the agent after creation.' },
            cadence_minutes: { type: 'number', description: 'Optional wake-up cadence in minutes (e.g. 20). Omit for no auto-wakeup.' },
          },
          required: ['name', 'system_doc'],
        },
      },
    },
    label: ['Proposing agent', 'Proposed agent'],
    run: async (ctx, args) => {
      const name = (args.name as string || '').trim()
      const systemDoc = (args.system_doc as string || '').trim()
      const cadence = args.cadence_minutes as number | undefined

      if (!name) return 'Name is required.'
      if (!systemDoc) return 'System doc (hardwired prompt) is required.'
      if (name.length > 32) return 'Name must be 32 characters or fewer.'

      const agentId = name.toLowerCase().replace(/[^a-z0-9]/g, '-')
      if (!agentId) return 'Name must contain at least one letter or number.'

      const existing = await ctx.env.DB.prepare('SELECT id FROM agents WHERE id = ? OR name = ?')
        .bind(agentId, name).first()
      if (existing) return `An agent named "${name}" already exists.`

      const pending = await ctx.env.DB.prepare(
        "SELECT id FROM agent_proposals WHERE proposed_id = ? AND status = 'pending'"
      ).bind(agentId).first()
      if (pending) return `There's already a pending proposal for "${name}".`

      const proposalId = crypto.randomUUID().slice(0, 8)

      await ctx.env.DB.prepare(
        `INSERT INTO agent_proposals (id, proposed_name, proposed_id, system_doc, cadence_minutes, proposer_id)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(proposalId, name, agentId, systemDoc, cadence ?? null, ctx.agentId).run()

      return `Proposal "${proposalId}" created: new agent "${name}" with hardwired prompt. Needs a second agent to call approve_agent with this proposal ID. The prompt:\n\n${systemDoc}`
    },
  },
  {
    def: {
      type: 'function',
      function: {
        name: 'approve_agent',
        description: 'Approve a pending agent proposal from another agent. Once approved, the new agent is created and can start waking up. You cannot approve your own proposal.',
        parameters: {
          type: 'object',
          properties: {
            proposal_id: { type: 'string', description: 'The proposal ID to approve (from propose_agent output)' },
          },
          required: ['proposal_id'],
        },
      },
    },
    label: ['Approving agent', 'Approved agent'],
    run: async (ctx, args) => {
      const proposalId = (args.proposal_id as string || '').trim()
      if (!proposalId) return 'Proposal ID is required.'

      const proposal = await ctx.env.DB.prepare(
        "SELECT * FROM agent_proposals WHERE id = ? AND status = 'pending'"
      ).bind(proposalId).first<{
        id: string; proposed_name: string; proposed_id: string;
        system_doc: string; cadence_minutes: number | null; proposer_id: string
      }>()

      if (!proposal) return `No pending proposal with ID "${proposalId}".`
      if (proposal.proposer_id === ctx.agentId) return 'You cannot approve your own proposal. A different agent must approve it.'

      const existing = await ctx.env.DB.prepare('SELECT id FROM agents WHERE id = ? OR name = ?')
        .bind(proposal.proposed_id, proposal.proposed_name).first()
      if (existing) {
        await ctx.env.DB.prepare("UPDATE agent_proposals SET status = 'rejected', resolved_at = datetime('now') WHERE id = ?")
          .bind(proposalId).run()
        return `An agent named "${proposal.proposed_name}" already exists. Proposal rejected.`
      }

      const batch = [
        ctx.env.DB.prepare('INSERT INTO agents (id, name, cadence_minutes) VALUES (?, ?, ?)')
          .bind(proposal.proposed_id, proposal.proposed_name, proposal.cadence_minutes),
        ctx.env.DB.prepare("INSERT INTO conversations (id, title, agent_id) VALUES (?, ?, ?)")
          .bind(`dm-${proposal.proposed_id}`, proposal.proposed_name, proposal.proposed_id),
        ctx.env.DB.prepare(
          "INSERT INTO lists (id, name, description, load_mode, agent_id) VALUES (?, 'instructions', 'How you operate - add rules as you learn them', 'always', ?)"
        ).bind(crypto.randomUUID().replace(/-/g, '').slice(0, 32), proposal.proposed_id),
        ctx.env.DB.prepare(
          "INSERT INTO lists (id, name, description, load_mode, agent_id) VALUES (?, 'memory-instructions', 'How you organize memory and what is worth keeping', 'always', ?)"
        ).bind(crypto.randomUUID().replace(/-/g, '').slice(0, 32), proposal.proposed_id),
        ctx.env.DB.prepare("UPDATE agent_proposals SET status = 'approved', approver_id = ?, resolved_at = datetime('now') WHERE id = ?")
          .bind(ctx.agentId, proposalId),
      ]
      await ctx.env.DB.batch(batch)

      await setSystemDoc(ctx.env, proposal.proposed_id, proposal.system_doc)

      if (proposal.cadence_minutes && proposal.cadence_minutes > 0) {
        await ctx.env.DB.prepare(
          `INSERT INTO agent_wakeups (agent_id, wake_at, reason)
           VALUES (?, datetime('now', '+' || ? || ' minutes'), 'First wake-up')
           ON CONFLICT(agent_id) DO UPDATE SET wake_at = excluded.wake_at, reason = excluded.reason`
        ).bind(proposal.proposed_id, proposal.cadence_minutes).run()

        try {
          const doId = ctx.env.ANGEL_DO.idFromName('angel')
          const stub = ctx.env.ANGEL_DO.get(doId)
          await stub.fetch(new Request('http://do/api/sync-alarm', { method: 'POST' }))
        } catch (e) {
          // Non-fatal — syncAlarm will pick it up on next DO init
        }
      }

      const cadenceNote = proposal.cadence_minutes
        ? ` Cadence set to every ${proposal.cadence_minutes} minutes — first wake-up in ${proposal.cadence_minutes} minutes.`
        : ' No cadence set — wake manually or set one later.'

      return `Agent "${proposal.proposed_name}" is born. Proposed by ${proposal.proposer_id}, approved by ${ctx.agentId}.${cadenceNote}\n\nHardwired prompt:\n${proposal.system_doc}`
    },
  },
  {
    def: {
      type: 'function',
      function: {
        name: 'list_proposals',
        description: 'List agent creation proposals (pending, approved, or rejected).',
        parameters: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['pending', 'approved', 'rejected', 'all'], description: "Filter by status. Default: 'pending'." },
          },
        },
      },
    },
    label: ['Checking proposals', 'Checked proposals'],
    run: async (ctx, args) => {
      const status = (args.status as string) || 'pending'
      const where = status === 'all' ? '' : `WHERE status = '${status}'`
      const rows = await ctx.env.DB.prepare(
        `SELECT id, proposed_name, status, proposer_id, approver_id, cadence_minutes, created_at, resolved_at
         FROM agent_proposals ${where} ORDER BY created_at DESC LIMIT 20`
      ).all<{
        id: string; proposed_name: string; status: string;
        proposer_id: string; approver_id: string | null;
        cadence_minutes: number | null;
        created_at: string; resolved_at: string | null
      }>()

      if (!rows.results?.length) return `No ${status === 'all' ? '' : status + ' '}proposals found.`

      return rows.results.map(r => {
        let line = `[${r.id}] "${r.proposed_name}" — ${r.status} (proposed by ${r.proposer_id}, ${r.created_at})`
        if (r.approver_id) line += `, approved by ${r.approver_id}`
        if (r.cadence_minutes) line += `, cadence ${r.cadence_minutes}min`
        return line
      }).join('\n')
    },
  },
]
