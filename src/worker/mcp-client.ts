// A small MCP client over Streamable HTTP: JSON-RPC POSTs, answered as plain
// JSON or as a short SSE stream. Each use opens a session (initialize, then the
// call) and caches the session id per connector for the life of the DO, so a
// burst of calls doesn't re-initialize every time. Remote servers only: a Worker
// can't spawn local processes, so stdio servers are out.
//
// Auth is a bearer token from the caller (OAuth or a pasted token). A 401 is
// surfaced as McpAuthError so the caller can refresh or ask for a sign-in.

export const PROTOCOL_VERSION = '2025-06-18'
const CLIENT_INFO = { name: 'Angel', version: '1.0' }
const TIMEOUT_MS = 60_000

export interface McpTool {
  name: string
  title?: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface McpServerInfo {
  name?: string
  title?: string
  version?: string
  instructions?: string
}

export class McpAuthError extends Error {
  // The WWW-Authenticate header, which may point at the resource metadata.
  constructor(public wwwAuthenticate: string | null) {
    super('The server wants a sign-in')
  }
}

export class McpError extends Error {}

interface Session { id: string | null; info: McpServerInfo }
const sessions = new Map<string, Session>() // key: url + token

let nextId = 1

function headers(token: string | null, sessionId: string | null): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': PROTOCOL_VERSION,
  }
  if (token) h.Authorization = `Bearer ${token}`
  if (sessionId) h['Mcp-Session-Id'] = sessionId
  return h
}

// Pull the JSON-RPC message with our id out of an SSE body. Servers may send
// notifications or progress first; those are skipped.
export function parseSse(body: string, id: number): unknown {
  let data: string[] = []
  const flush = (): unknown => {
    if (!data.length) return undefined
    const text = data.join('\n')
    data = []
    try {
      const msg = JSON.parse(text) as { id?: unknown }
      if (msg && msg.id === id) return msg
    } catch { /* not JSON; skip */ }
    return undefined
  }
  for (const line of body.split(/\r?\n/)) {
    if (line === '') {
      const m = flush()
      if (m) return m
    } else if (line.startsWith('data:')) {
      data.push(line.slice(5).replace(/^ /, ''))
    }
  }
  return flush()
}

async function post(url: string, token: string | null, sessionId: string | null, body: object): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    return await fetch(url, { method: 'POST', headers: headers(token, sessionId), body: JSON.stringify(body), signal: controller.signal })
  } catch (e) {
    if (controller.signal.aborted) throw new McpError('The server took too long to answer')
    throw new McpError(`Couldn't reach the server: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    clearTimeout(timer)
  }
}

async function rpc(url: string, token: string | null, sessionId: string | null, method: string, params: object): Promise<{ result: unknown; sessionId: string | null }> {
  const id = nextId++
  const res = await post(url, token, sessionId, { jsonrpc: '2.0', id, method, params })
  if (res.status === 401) throw new McpAuthError(res.headers.get('WWW-Authenticate'))
  if (res.status === 404 && sessionId) throw new SessionExpired()
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 300)
    if (res.status === 405 || res.status === 404) {
      throw new McpError(`The server answered ${res.status}. Check the URL - it is usually the one ending in /mcp. Servers that only speak the old SSE transport aren't supported yet.`)
    }
    throw new McpError(`The server answered ${res.status}${text ? `: ${text}` : ''}`)
  }
  const newSession = res.headers.get('Mcp-Session-Id') ?? sessionId
  const type = res.headers.get('Content-Type') || ''
  const text = await res.text()
  let msg: { result?: unknown; error?: { code?: number; message?: string } } | undefined
  try {
    msg = (type.includes('text/event-stream') ? parseSse(text, id) : JSON.parse(text)) as typeof msg
  } catch {
    throw new McpError(`The server sent something that isn't JSON-RPC: ${text.slice(0, 200)}`)
  }
  if (!msg) throw new McpError('The server closed the stream without answering')
  if (msg.error) throw new McpError(msg.error.message || `Error ${msg.error.code ?? ''}`.trim())
  return { result: msg.result, sessionId: newSession }
}

class SessionExpired extends Error {}

async function notify(url: string, token: string | null, sessionId: string | null, method: string): Promise<void> {
  const res = await post(url, token, sessionId, { jsonrpc: '2.0', method })
  await res.body?.cancel()
}

async function open(url: string, token: string | null): Promise<Session> {
  const key = `${url}\n${token ?? ''}`
  const cached = sessions.get(key)
  if (cached) return cached
  const { result, sessionId } = await rpc(url, token, null, 'initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: CLIENT_INFO,
  })
  const r = (result ?? {}) as { serverInfo?: McpServerInfo; instructions?: string }
  await notify(url, token, sessionId, 'notifications/initialized')
  const session: Session = { id: sessionId, info: { ...r.serverInfo, instructions: r.instructions } }
  sessions.set(key, session)
  return session
}

// One request inside a session, re-opening once if the server forgot it.
async function request(url: string, token: string | null, method: string, params: object): Promise<{ result: unknown; info: McpServerInfo }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const session = await open(url, token)
    try {
      const { result } = await rpc(url, token, session.id, method, params)
      return { result, info: session.info }
    } catch (e) {
      sessions.delete(`${url}\n${token ?? ''}`)
      if (e instanceof SessionExpired && attempt === 0) continue
      throw e
    }
  }
  throw new McpError('The server keeps dropping the session')
}

export function forgetSessions(url: string): void {
  for (const key of sessions.keys()) if (key.startsWith(`${url}\n`)) sessions.delete(key)
}

export async function listTools(url: string, token: string | null): Promise<{ tools: McpTool[]; info: McpServerInfo }> {
  const tools: McpTool[] = []
  let cursor: string | undefined
  let info: McpServerInfo = {}
  for (let page = 0; page < 20; page++) {
    const r = await request(url, token, 'tools/list', cursor ? { cursor } : {})
    info = r.info
    const res = (r.result ?? {}) as { tools?: McpTool[]; nextCursor?: string }
    tools.push(...(res.tools ?? []))
    if (!res.nextCursor) break
    cursor = res.nextCursor
  }
  return { tools, info }
}

interface ContentPart {
  type: string
  text?: string
  mimeType?: string
  uri?: string
  name?: string
  resource?: { uri?: string; text?: string; mimeType?: string }
}

// A tool result as text for the model: text parts as-is, structured content as
// JSON when there is no text, and a note for what it can't see (images, audio).
export function formatToolResult(result: unknown): { text: string; isError: boolean } {
  const r = (result ?? {}) as { content?: ContentPart[]; structuredContent?: unknown; isError?: boolean }
  const out: string[] = []
  for (const part of r.content ?? []) {
    if (part.type === 'text' && part.text !== undefined) out.push(part.text)
    else if (part.type === 'resource' && part.resource?.text !== undefined) out.push(part.resource.text)
    else if (part.type === 'resource_link') out.push(`[link: ${part.name || ''} ${part.uri || ''}]`.replace(/\s+\]/, ']'))
    else if (part.type === 'image' || part.type === 'audio') out.push(`[${part.type} (${part.mimeType || 'unknown type'}) - not shown]`)
    else if (part.type === 'resource') out.push(`[resource: ${part.resource?.uri || ''}]`)
  }
  if (!out.length && r.structuredContent !== undefined) out.push(JSON.stringify(r.structuredContent, null, 2))
  return { text: out.join('\n\n') || '(no content)', isError: !!r.isError }
}

export async function callTool(url: string, token: string | null, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const { result } = await request(url, token, 'tools/call', { name, arguments: args })
  return formatToolResult(result)
}
