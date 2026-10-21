// Connectors: MCP servers Angel can use. Each one is a row in the user's own
// database with its URL, how it signs in, and the tool list it last reported.
// Angel sees a one-line roster in his prompt and loads tool schemas on demand
// (tools/connectors.ts), so a server with fifty tools costs nothing until used.
//
// Both the person (Settings) and Angel (his tools) can add and remove them. A
// sign-in is always the person's: Angel can only hand over the link.

import type { Env } from './types'
import { listTools, callTool, forgetSessions, McpAuthError, McpError, type McpTool, type McpServerInfo } from './mcp-client'
import { prepareOAuth, authorizationUrl, exchangeCode, refreshAccess, needsRefresh, OAuthError, type OAuthState } from './mcp-oauth'

export type ConnectorStatus = 'connected' | 'needs_auth' | 'error'
export type ConnectorAuth = 'none' | 'oauth' | 'token'

interface ConnectorRow {
  id: string
  name: string
  url: string
  description: string | null
  auth: ConnectorAuth
  token: string | null
  oauth: string | null
  status: ConnectorStatus
  error: string | null
  tools: string | null
  server_info: string | null
  tools_at: string | null
  added_by: string
  created_at: string
  updated_at: string
}

// What the client sees: never a token.
export interface ConnectorInfo {
  id: string
  name: string
  url: string
  description: string | null
  auth: ConnectorAuth
  status: ConnectorStatus
  error: string | null
  tools: Array<{ name: string; description: string }>
  serverName: string | null
  addedBy: string
  createdAt: string
  toolsAt: string | null
}

const OAUTH_PENDING_TTL_MS = 30 * 60_000
const TOOLS_STALE_MS = 6 * 3600_000

export const CALLBACK_PATH = '/api/connectors/callback'

const redirectUri = (env: Env) => `${env.APP_ORIGIN || 'https://angel.finereli.com'}${CALLBACK_PATH}`

function parseJson<T>(s: string | null, fallback: T): T {
  if (!s) return fallback
  try { return JSON.parse(s) as T } catch { return fallback }
}

const firstLine = (s: string | undefined, max = 160): string | null => {
  const t = s?.trim().split(/\n/)[0]?.trim()
  if (!t) return null
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

function toInfo(row: ConnectorRow): ConnectorInfo {
  const tools = parseJson<McpTool[]>(row.tools, [])
  const server = parseJson<McpServerInfo>(row.server_info, {})
  return {
    id: row.id, name: row.name, url: row.url, description: row.description ?? firstLine(server.instructions),
    auth: row.auth, status: row.status, error: row.error,
    tools: tools.map(t => ({ name: t.name, description: firstLine(t.description, 200) ?? '' })),
    serverName: server.title || server.name || null,
    addedBy: row.added_by, createdAt: row.created_at, toolsAt: row.tools_at,
  }
}

// notion from mcp.notion.com, linear from mcp.linear.app.
export function slugFromUrl(url: string): string {
  let host = ''
  try { host = new URL(url).hostname } catch { return 'connector' }
  const parts = host.split('.').filter(p => !['mcp', 'www', 'api', 'app', 'server'].includes(p))
  const core = parts.length > 1 ? parts.slice(0, -1) : parts
  return (core.join('-').toLowerCase().replace(/[^a-z0-9-]/g, '') || 'connector').slice(0, 32)
}

export function cleanName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
}

export function normalizeUrl(raw: string): string {
  const s = raw.trim()
  const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`)
  if (u.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(u.hostname)) throw new Error('Connector URLs must use https')
  return u.toString()
}

async function rows(env: Env): Promise<ConnectorRow[]> {
  const r = await env.DB.prepare(`SELECT * FROM connectors ORDER BY created_at`).all<ConnectorRow>()
  return r.results
}

export async function listConnectors(env: Env): Promise<ConnectorInfo[]> {
  return (await rows(env)).map(toInfo)
}

async function find(env: Env, idOrName: string): Promise<ConnectorRow | null> {
  const key = idOrName.trim()
  return await env.DB.prepare(`SELECT * FROM connectors WHERE id = ? OR name = ?`).bind(key, cleanName(key)).first<ConnectorRow>()
}

async function update(env: Env, id: string, fields: Partial<ConnectorRow>): Promise<void> {
  const keys = Object.keys(fields)
  if (!keys.length) return
  await env.DB.prepare(`UPDATE connectors SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
    .bind(...keys.map(k => (fields as Record<string, unknown>)[k] ?? null), id).run()
}

const friendly = (e: unknown) => e instanceof Error ? e.message : String(e)

// A valid bearer token for a connector, renewing an OAuth one that is about to
// expire. Null for a server that needs none.
async function tokenFor(env: Env, row: ConnectorRow): Promise<string | null> {
  if (row.auth === 'token') return row.token
  if (row.auth !== 'oauth') return null
  let oauth = parseJson<OAuthState | null>(row.oauth, null)
  if (!oauth?.access_token) throw new McpAuthError(null)
  if (needsRefresh(oauth)) {
    oauth = await refreshAccess(oauth, row.url)
    await update(env, row.id, { oauth: JSON.stringify(oauth) })
  }
  return oauth.access_token ?? null
}

// Run against the server with whatever auth the connector has; on a 401, renew
// the OAuth token once and retry, else mark it as needing a sign-in.
async function withAuth<T>(env: Env, row: ConnectorRow, fn: (token: string | null) => Promise<T>): Promise<T> {
  try {
    return await fn(await tokenFor(env, row))
  } catch (e) {
    if (!(e instanceof McpAuthError) && !(e instanceof OAuthError)) throw e
    const oauth = parseJson<OAuthState | null>(row.oauth, null)
    if (e instanceof McpAuthError && row.auth === 'oauth' && oauth?.refresh_token) {
      try {
        const renewed = await refreshAccess(oauth, row.url)
        await update(env, row.id, { oauth: JSON.stringify(renewed) })
        return await fn(renewed.access_token ?? null)
      } catch (again) {
        if (!(again instanceof McpAuthError) && !(again instanceof OAuthError)) throw again
      }
    }
    const message = row.auth === 'token' ? 'The server refused the token.' : 'The sign-in has expired.'
    await update(env, row.id, { status: 'needs_auth', error: message })
    throw new ConnectorAuthNeeded(row.name)
  }
}

export class ConnectorAuthNeeded extends Error {
  constructor(public connector: string) {
    super(`${connector} needs a sign-in`)
  }
}

// Ask the server for its tools and save them.
async function refreshTools(env: Env, row: ConnectorRow): Promise<ConnectorRow> {
  try {
    const { tools, info } = await withAuth(env, row, token => listTools(row.url, token))
    await update(env, row.id, {
      tools: JSON.stringify(tools), server_info: JSON.stringify(info),
      tools_at: new Date().toISOString(), status: 'connected', error: null,
    })
  } catch (e) {
    if (!(e instanceof ConnectorAuthNeeded)) await update(env, row.id, { status: 'error', error: friendly(e) })
  }
  return (await find(env, row.id))!
}

export interface AddResult {
  connector: ConnectorInfo
  // Present when the person has to sign in before it can be used.
  signInUrl?: string
}

export async function addConnector(env: Env, input: { url: string; name?: string; token?: string; description?: string; addedBy: 'person' | 'angel' }): Promise<AddResult> {
  const url = normalizeUrl(input.url)
  const existing = await env.DB.prepare(`SELECT id FROM connectors WHERE url = ?`).bind(url).first<{ id: string }>()
  if (existing) throw new Error('That server is already connected')

  let name = cleanName(input.name || '') || slugFromUrl(url)
  const taken = new Set((await rows(env)).map(r => r.name))
  for (let n = 2; taken.has(name); n++) name = `${name.replace(/-\d+$/, '')}-${n}`

  const id = crypto.randomUUID()
  const token = input.token?.trim() || null
  await env.DB.prepare(
    `INSERT INTO connectors (id, name, url, description, auth, token, status, added_by) VALUES (?, ?, ?, ?, ?, ?, 'error', ?)`
  ).bind(id, name, url, input.description?.trim() || null, token ? 'token' : 'none', token, input.addedBy).run()
  let row = (await find(env, id))!

  if (token) {
    row = await refreshTools(env, row)
    return { connector: toInfo(row) }
  }

  // No token: try it open, and if the server wants a sign-in, set up OAuth.
  try {
    const { tools, info } = await listTools(url, null)
    await update(env, id, { tools: JSON.stringify(tools), server_info: JSON.stringify(info), tools_at: new Date().toISOString(), status: 'connected', error: null })
    return { connector: toInfo((await find(env, id))!) }
  } catch (e) {
    if (!(e instanceof McpAuthError)) {
      await update(env, id, { error: friendly(e) })
      return { connector: toInfo((await find(env, id))!) }
    }
    try {
      const oauth = await prepareOAuth(url, e.wwwAuthenticate, redirectUri(env))
      await update(env, id, { auth: 'oauth', oauth: JSON.stringify(oauth), status: 'needs_auth', error: null })
      const signInUrl = await startSignIn(env, id)
      return { connector: toInfo((await find(env, id))!), signInUrl }
    } catch (oe) {
      await update(env, id, { auth: 'oauth', status: 'error', error: friendly(oe) })
      return { connector: toInfo((await find(env, id))!) }
    }
  }
}

// A fresh sign-in link. The state is also written to the shared control plane,
// because the callback arrives at the worker with nothing but the state to say
// whose Durable Object it belongs to.
export async function startSignIn(env: Env, idOrName: string): Promise<string> {
  const row = await find(env, idOrName)
  if (!row) throw new Error(`No connector called ${idOrName}`)
  let oauth = parseJson<OAuthState | null>(row.oauth, null)
  if (!oauth || oauth.redirect_uri !== redirectUri(env)) {
    // Never set up (it was open or used a token) or set up from another origin.
    oauth = await prepareOAuth(row.url, null, redirectUri(env))
  }
  const { url, oauth: withPending } = await authorizationUrl(oauth, row.url)
  await update(env, row.id, { auth: 'oauth', oauth: JSON.stringify(withPending) })
  if (env.CONTROL_DB && env.USER_SUB) {
    await env.CONTROL_DB.prepare(`DELETE FROM connector_auth WHERE created_at < datetime('now', '-1 day')`).run()
    await env.CONTROL_DB.prepare(`INSERT INTO connector_auth (state, sub) VALUES (?, ?)`).bind(withPending.pending!.state, env.USER_SUB).run()
  }
  return url
}

// The person came back from the server's sign-in page.
export async function finishSignIn(env: Env, state: string, code: string): Promise<ConnectorInfo> {
  const all = await rows(env)
  const row = all.find(r => parseJson<OAuthState | null>(r.oauth, null)?.pending?.state === state)
  if (!row) throw new Error('This sign-in link is no longer valid. Start again from Settings.')
  const oauth = parseJson<OAuthState>(row.oauth, null as never)
  if (Date.now() - oauth.pending!.created_at > OAUTH_PENDING_TTL_MS) throw new Error('This sign-in took too long. Start again from Settings.')
  const signedIn = await exchangeCode(oauth, code, row.url)
  forgetSessions(row.url)
  await update(env, row.id, { oauth: JSON.stringify(signedIn), status: 'connected', error: null })
  return toInfo(await refreshTools(env, (await find(env, row.id))!))
}

export async function removeConnector(env: Env, idOrName: string): Promise<ConnectorInfo> {
  const row = await find(env, idOrName)
  if (!row) throw new Error(`No connector called ${idOrName}`)
  await env.DB.prepare(`DELETE FROM connectors WHERE id = ?`).bind(row.id).run()
  forgetSessions(row.url)
  return toInfo(row)
}

export async function reloadConnector(env: Env, idOrName: string): Promise<ConnectorInfo> {
  const row = await find(env, idOrName)
  if (!row) throw new Error(`No connector called ${idOrName}`)
  forgetSessions(row.url)
  return toInfo(await refreshTools(env, row))
}

// Tool schemas for one connector, fetched again when the cached list is old.
export async function connectorTools(env: Env, idOrName: string): Promise<{ row: ConnectorInfo; tools: McpTool[] }> {
  let row = await find(env, idOrName)
  if (!row) throw new Error(`No connector called ${idOrName}`)
  const stale = !row.tools_at || Date.now() - Date.parse(row.tools_at) > TOOLS_STALE_MS
  if (row.status === 'needs_auth') throw new ConnectorAuthNeeded(row.name)
  if (stale || row.status === 'error') row = await refreshTools(env, row)
  if (row.status === 'needs_auth') throw new ConnectorAuthNeeded(row.name)
  if (row.status === 'error') throw new McpError(row.error || 'The server is not answering')
  return { row: toInfo(row), tools: parseJson<McpTool[]>(row.tools, []) }
}

export async function useConnectorTool(env: Env, idOrName: string, tool: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const row = await find(env, idOrName)
  if (!row) throw new Error(`No connector called ${idOrName}`)
  if (row.status === 'needs_auth') throw new ConnectorAuthNeeded(row.name)
  const result = await withAuth(env, row, token => callTool(row.url, token, tool, args))
  if (row.status !== 'connected') await update(env, row.id, { status: 'connected', error: null })
  return result
}

// The roster in the system prompt: one line each, so Angel knows what exists.
export async function buildConnectorsPreamble(env: Env): Promise<string | null> {
  const all = await listConnectors(env)
  if (!all.length) return null
  const lines = all.map(c => {
    const state = c.status === 'connected' ? '' : c.status === 'needs_auth' ? ' (needs a sign-in)' : ' (not answering)'
    return `- ${c.name}${state}: ${c.description || c.serverName || c.url}`
  })
  return `# Connectors\nServices you can use through MCP. connector_tools shows a connector's tools; call_connector runs one.\n${lines.join('\n')}`
}
