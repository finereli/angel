import type { Tool } from './registry'

export const trackerTools: Tool[] = [
  {
    def: {
      type: 'function',
      function: {
        name: 'track_service',
        description: 'Log or update an x402 service in the tracker. Use this to build the outbound CRM — every service you discover or probe becomes a lead.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Service endpoint URL (unique key)' },
            name: { type: 'string', description: 'Service name' },
            description: { type: 'string', description: 'What the service does' },
            price: { type: 'string', description: 'Price (e.g. "$0.005", "$1.00")' },
            network: { type: 'string', description: 'Payment network (e.g. "eip155:8453")' },
            tags: { type: 'string', description: 'Comma-separated tags' },
            calls_30d: { type: 'number', description: 'Calls in last 30 days' },
            payers_30d: { type: 'number', description: 'Unique payers in last 30 days' },
            builder: { type: 'string', description: 'Builder/provider name or domain' },
            status: { type: 'string', description: "Status: discovered, probed, contacted, replied, partnered, competitor, dead" },
            notes: { type: 'string', description: 'Free-form notes' },
          },
          required: ['url'],
        },
      },
    },
    label: ['Tracking service', 'Tracked service'],
    run: async (ctx, args) => {
      const url = (args.url as string).trim()
      if (!url) return 'URL is required.'

      const existing = await ctx.env.DB.prepare('SELECT id FROM x402_services WHERE url = ?').bind(url).first<{ id: number }>()

      if (existing) {
        const sets: string[] = ["updated_at = datetime('now')"]
        const binds: unknown[] = []
        for (const [key, val] of Object.entries(args)) {
          if (key === 'url' || val === undefined || val === null) continue
          sets.push(`${key} = ?`)
          binds.push(val)
        }
        binds.push(existing.id)
        await ctx.env.DB.prepare(`UPDATE x402_services SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run()
        return `Updated service: ${url}`
      }

      await ctx.env.DB.prepare(
        `INSERT INTO x402_services (url, name, description, price, network, tags, calls_30d, payers_30d, builder, status, notes, discovered_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        url,
        (args.name as string) || null,
        (args.description as string) || null,
        (args.price as string) || null,
        (args.network as string) || null,
        (args.tags as string) || null,
        (args.calls_30d as number) ?? null,
        (args.payers_30d as number) ?? null,
        (args.builder as string) || null,
        (args.status as string) || 'discovered',
        (args.notes as string) || null,
        ctx.agentId,
      ).run()
      return `Tracked new service: ${url}`
    },
  },
  {
    def: {
      type: 'function',
      function: {
        name: 'list_services',
        description: 'List tracked x402 services. Filter by status, builder, or search by name/URL.',
        parameters: {
          type: 'object',
          properties: {
            status: { type: 'string', description: 'Filter by status (discovered, probed, contacted, etc.)' },
            query: { type: 'string', description: 'Search in name, url, description, builder, notes' },
            limit: { type: 'number', description: 'Max results (default 20)' },
          },
        },
      },
    },
    label: ['Listing services', 'Listed services'],
    run: async (ctx, args) => {
      const status = args.status as string | undefined
      const query = args.query as string | undefined
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100)

      let sql = 'SELECT * FROM x402_services WHERE 1=1'
      const binds: unknown[] = []

      if (status) {
        sql += ' AND status = ?'
        binds.push(status)
      }
      if (query) {
        sql += ' AND (url LIKE ? OR name LIKE ? OR description LIKE ? OR builder LIKE ? OR notes LIKE ?)'
        const p = `%${query}%`
        binds.push(p, p, p, p, p)
      }
      sql += ' ORDER BY updated_at DESC LIMIT ?'
      binds.push(limit)

      const rows = await ctx.env.DB.prepare(sql).bind(...binds).all<{
        url: string; name: string | null; price: string | null; calls_30d: number | null;
        payers_30d: number | null; builder: string | null; status: string; notes: string | null;
        discovered_by: string | null; updated_at: string
      }>()

      if (!rows.results?.length) return 'No tracked services found.'

      return rows.results.map(r => {
        let line = `[${r.status}] ${r.name || r.url}`
        if (r.name) line += ` — ${r.url}`
        if (r.price) line += ` @ ${r.price}`
        if (r.calls_30d != null) line += ` (${r.calls_30d} calls / ${r.payers_30d ?? '?'} payers)`
        if (r.builder) line += ` by ${r.builder}`
        if (r.notes) line += ` — ${r.notes}`
        return line
      }).join('\n')
    },
  },
]
