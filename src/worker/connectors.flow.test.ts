import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { userDb, migrate, type SqlLike, type Transact } from './user-db'
import type { Env } from './types'
import { addConnector, finishSignIn, listConnectors, buildConnectorsPreamble } from './connectors'
import { connectorToolset } from './tools/connectors'
import type { ToolContext } from './tools/registry'

// The whole connector life cycle against a fake OAuth-protected MCP server:
// add (needs a sign-in), come back from the sign-in, use a tool, survive a
// revoked access token by refreshing, and fall back to "needs a sign-in" when
// the refresh token is gone too.

function db() {
  const raw = new DatabaseSync(':memory:')
  const sql: SqlLike = {
    exec(query, ...b) {
      if (b.length === 0 && /;\s*\S/.test(query)) { raw.exec(query); return { toArray: () => [] } }
      const rows = raw.prepare(query).all(...(b as never[])) as Record<string, unknown>[]
      return { toArray: () => rows }
    },
  }
  const transact: Transact = (fn) => { raw.exec('BEGIN'); try { const r = fn(); raw.exec('COMMIT'); return r } catch (e) { raw.exec('ROLLBACK'); throw e } }
  migrate(sql, transact)
  return userDb(sql, transact)
}

const O = 'https://fake.example.com'
function fakeServer() {
  const s = { tokens: new Set<string>(), refresh: new Set<string>(), n: 0, calls: [] as string[] }
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const body = typeof init?.body === 'string' ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : ''
    s.calls.push(u.pathname)
    if (u.pathname === '/.well-known/oauth-protected-resource/mcp') return json({ resource: `${O}/mcp`, authorization_servers: [O] })
    if (u.pathname === '/.well-known/oauth-authorization-server') return json({ issuer: O, authorization_endpoint: `${O}/authorize`, token_endpoint: `${O}/token`, registration_endpoint: `${O}/register` })
    if (u.pathname === '/register') return json({ client_id: 'client-1' }, 201)
    if (u.pathname === '/token') {
      const p = new URLSearchParams(body)
      if (p.get('grant_type') === 'authorization_code' && p.get('code') !== 'good-code') return json({ error: 'invalid_grant' }, 400)
      if (p.get('grant_type') === 'refresh_token' && !s.refresh.has(p.get('refresh_token')!)) return json({ error: 'invalid_grant' }, 400)
      const t = `tok${++s.n}`, r = `ref${s.n}`
      s.tokens.add(t); s.refresh.add(r)
      return json({ access_token: t, refresh_token: r, expires_in: 3600 })
    }
    if (u.pathname === '/mcp') {
      const auth = new Headers(init?.headers).get('Authorization')?.replace('Bearer ', '') ?? ''
      if (!s.tokens.has(auth)) return json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': `Bearer resource_metadata="${O}/.well-known/oauth-protected-resource/mcp"` })
      const m = JSON.parse(body)
      if (!('id' in m)) return new Response(null, { status: 202 })
      const reply = (result: unknown) => new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result })}\n\n`, { headers: { 'Content-Type': 'text/event-stream', 'Mcp-Session-Id': 'sess' } })
      if (m.method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake', title: 'Fake Notes' }, instructions: 'Notes for testing.\nMore detail.' })
      if (m.method === 'tools/list') return reply({ tools: [{ name: 'echo', description: 'Echo back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] })
      if (m.method === 'tools/call') return reply({ content: [{ type: 'text', text: `echo: ${m.params.arguments.text}` }] })
    }
    return json({}, 404)
  }
  return { s, handler }
}

const tool = (name: string) => connectorToolset.find(t => t.def.function.name === name)!

describe('connector flow', () => {
  let env: Env
  let server: ReturnType<typeof fakeServer>
  beforeEach(() => {
    server = fakeServer()
    vi.stubGlobal('fetch', vi.fn(server.handler))
    env = { DB: db(), APP_ORIGIN: 'https://angel.test' } as unknown as Env
  })
  afterEach(() => vi.unstubAllGlobals())

  it('signs in, calls tools, refreshes, and asks for a sign-in when it must', async () => {
    const { connector, signInUrl } = await addConnector(env, { url: `${O}/mcp`, name: 'fake', addedBy: 'person' })
    expect(connector.status).toBe('needs_auth')
    const link = new URL(signInUrl!)
    expect(link.searchParams.get('redirect_uri')).toBe('https://angel.test/api/connectors/callback')
    expect(link.searchParams.get('code_challenge_method')).toBe('S256')
    expect(link.searchParams.get('resource')).toBe(`${O}/mcp`)

    const ctx: ToolContext = { env, conversationId: 'main', agentId: 'angel' }
    expect(await tool('call_connector').run(ctx, { name: 'fake', tool: 'echo', arguments: { text: 'hi' } })).toMatch(/needs a sign-in/)

    await expect(finishSignIn(env, 'wrong-state', 'good-code')).rejects.toThrow(/no longer valid/)
    const signedIn = await finishSignIn(env, link.searchParams.get('state')!, 'good-code')
    expect(signedIn.status).toBe('connected')
    expect(signedIn.serverName).toBe('Fake Notes')
    expect(signedIn.tools.map(t => t.name)).toEqual(['echo'])

    expect(await buildConnectorsPreamble(env)).toContain('- fake: Notes for testing.')
    expect(await tool('connector_tools').run(ctx, { name: 'fake' })).toContain('## echo')
    expect(await tool('call_connector').run(ctx, { name: 'fake', tool: 'echo', arguments: { text: 'hi' } })).toBe('echo: hi')
    // Arguments sent as a JSON string still work.
    expect(await tool('call_connector').run(ctx, { name: 'fake', tool: 'echo', arguments: '{"text":"str"}' })).toBe('echo: str')

    // The server forgets the access token: one refresh, then it works.
    server.s.tokens.clear()
    expect(await tool('call_connector').run(ctx, { name: 'fake', tool: 'echo', arguments: { text: 'again' } })).toBe('echo: again')

    // And the refresh token too: now it really needs the person.
    server.s.tokens.clear(); server.s.refresh.clear()
    expect(await tool('call_connector').run(ctx, { name: 'fake', tool: 'echo', arguments: { text: 'x' } })).toMatch(/connector_sign_in/)
    expect((await listConnectors(env))[0]!.status).toBe('needs_auth')
    expect(await buildConnectorsPreamble(env)).toContain('fake (needs a sign-in)')
  })

  it('lets Angel add and remove an open server, and refuses duplicates', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      server.s.tokens.add('') // this server takes no token
      return server.handler(input, init)
    }))
    const ctx: ToolContext = { env, conversationId: 'main', agentId: 'angel' }
    expect(await tool('add_connector').run(ctx, { url: 'fake.example.com/mcp', name: 'Notes' })).toMatch(/Added notes with 1 tools/)
    expect(await tool('add_connector').run(ctx, { url: `${O}/mcp` })).toMatch(/already connected/)
    expect((await listConnectors(env))[0]!.addedBy).toBe('angel')
    expect(await tool('remove_connector').run(ctx, { name: 'notes' })).toBe('Removed notes.')
    expect(await listConnectors(env)).toEqual([])
  })
})
