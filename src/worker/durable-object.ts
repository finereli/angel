import type {
  Env, ClientMsg, ServerMsg, StreamSnapshot,
  ConversationRow, MessageRow, AgentEvent, StreamPart
} from './types'
import { runAgent, runMemoryPass } from './agent'
import { generateTitle } from './title'
import { buildObservationPyramid } from './memory'
import { buildStreamPyramid } from './stream-pyramid'

interface ActiveStream {
  conversationId: string
  seq: number
  text: string
  commitLen: number // length of `text` committed by prior tool rounds (reset floor)
  tools: Array<{ id: string; name: string; label: string; result?: string }>
  parts: StreamPart[] // ordered text/tool parts, as the reply is rendered
  aborted: boolean
}

interface WsAttachment {
  authed: boolean
}

export class AngelDO implements DurableObject {
  private state: DurableObjectState
  private env: Env
  private activeStreams = new Map<string, ActiveStream>()
  // Responses stream one at a time (one linear stream); memory work runs on its
  // own serialized chain so it never blocks the next response.
  private responseChain: Promise<void> = Promise.resolve()
  private memoryChain: Promise<void> = Promise.resolve()

  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.env = env
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/ws') {
      const upgrade = request.headers.get('Upgrade')
      if (upgrade !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 })
      }

      const pair = new WebSocketPair()
      const [client, server] = Object.values(pair)

      this.state.acceptWebSocket(server)
      server.serializeAttachment({ authed: false } satisfies WsAttachment)

      // Auth timeout: close if not authenticated within 10s
      const timeoutId = setTimeout(() => {
        const att = server.deserializeAttachment() as WsAttachment | null
        if (!att?.authed) {
          this.send(server, { type: 'auth:fail' })
          server.close(4001, 'Auth timeout')
        }
      }, 10_000)

      // Store timeout so we can clear it on auth (via a tag)
      server.serializeAttachment({ authed: false, timeoutId } as any)

      return new Response(null, { status: 101, webSocket: client })
    }

    return new Response('Not found', { status: 404 })
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== 'string') return

    let msg: ClientMsg
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }

    const att = ws.deserializeAttachment() as WsAttachment & { timeoutId?: number } | null

    // Handle auth
    if (msg.type === 'auth') {
      if (msg.pin === this.env.PIN) {
        if (att?.timeoutId) clearTimeout(att.timeoutId)
        ws.serializeAttachment({ authed: true } satisfies WsAttachment)

        const snapshots: StreamSnapshot[] = []
        for (const [, stream] of this.activeStreams) {
          snapshots.push({
            conversationId: stream.conversationId,
            seq: stream.seq,
            text: stream.text,
            tools: stream.tools,
            parts: stream.parts,
          })
        }
        this.send(ws, { type: 'auth:ok', activeStreams: snapshots })
      } else {
        this.send(ws, { type: 'auth:fail' })
        ws.close(4001, 'Bad PIN')
      }
      return
    }

    // All other messages require auth
    if (!att?.authed) {
      this.send(ws, { type: 'auth:fail' })
      return
    }

    switch (msg.type) {
      case 'ping':
        this.send(ws, { type: 'pong', ts: msg.ts })
        break

      case 'conv:list':
        await this.handleConvList(ws)
        break

      case 'conv:create':
        await this.handleConvCreate(ws)
        break

      case 'conv:archive':
        await this.handleConvArchive(ws, msg.conversationId)
        break

      case 'conv:load':
        await this.handleConvLoad(ws, msg.conversationId)
        break

      case 'chat':
        await this.handleChat(msg.conversationId, msg.clientMsgId, msg.content)
        break

      case 'stop':
        this.handleStop(msg.conversationId)
        break
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    // Nothing to clean up - streams keep running, D1 is the truth
  }

  webSocketError(ws: WebSocket, error: unknown) {
    ws.close(1011, 'WebSocket error')
  }

  // --- Handlers ---

  private async handleConvList(ws: WebSocket) {
    const result = await this.env.DB.prepare(
      `SELECT * FROM conversations WHERE archived = 0 ORDER BY updated_at DESC LIMIT 50`
    ).all<ConversationRow>()
    this.send(ws, { type: 'conv:list', conversations: result.results })
  }

  private async handleConvCreate(ws: WebSocket) {
    const id = crypto.randomUUID()
    await this.env.DB.prepare(
      `INSERT INTO conversations (id) VALUES (?)`
    ).bind(id).run()
    this.broadcast({ type: 'conv:created', conversationId: id })
  }

  private async handleConvArchive(ws: WebSocket, conversationId: string) {
    await this.env.DB.prepare(
      `UPDATE conversations SET archived = 1 WHERE id = ?`
    ).bind(conversationId).run()
    this.broadcast({ type: 'conv:archived', conversationId })
  }

  private async handleConvLoad(ws: WebSocket, conversationId: string) {
    const rows = await this.env.DB.prepare(
      `SELECT * FROM messages WHERE conversation_id = ? ORDER BY id ASC`
    ).bind(conversationId).all<MessageRow>()

    const stream = this.activeStreams.get(conversationId)
    const snapshot: StreamSnapshot | undefined = stream
      ? { conversationId, seq: stream.seq, text: stream.text, tools: stream.tools, parts: stream.parts }
      : undefined

    this.send(ws, {
      type: 'conv:messages',
      conversationId,
      messages: rows.results,
      stream: snapshot,
    })
  }

  private async handleChat(conversationId: string, clientMsgId: string, content: string) {
    // Persist and echo the user message immediately so it is never lost, even if
    // a turn ahead of it in the queue is still streaming.
    try {
      const result = await this.env.DB.prepare(
        `INSERT INTO messages (conversation_id, role, content) VALUES (?, 'user', ?)`
      ).bind(conversationId, content).run()
      await this.env.DB.prepare(
        `UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`
      ).bind(conversationId).run()
      this.broadcast({
        type: 'msg:user', conversationId, clientMsgId,
        messageId: result.meta.last_row_id, content,
      })
    } catch (e) {
      console.error('[handleChat] save user message failed:', e instanceof Error ? e.message : e)
      return
    }

    // Responses are serialized across the whole DO: a second message queues
    // behind the first rather than racing it or contaminating its context.
    const respLink = this.responseChain.then(() => this.streamResponse(conversationId, content))
    this.responseChain = respLink.then(() => {}, () => {})
    let assistantText = ''
    try { assistantText = await respLink }
    catch (e) { console.error('[handleChat] response failed:', e instanceof Error ? e.message : e) }

    // Memory work runs on its own chain so the next response never waits on it.
    // We await it here (DO state.waitUntil is a no-op) so the handler keeps the
    // DO alive until memory actually accretes.
    const memLink = this.memoryChain.then(() => this.postStreamWork(conversationId, content, assistantText))
    this.memoryChain = memLink.then(() => {}, () => {})
    try { await memLink }
    catch (e) { console.error('[handleChat] memory failed:', e instanceof Error ? e.message : e) }
  }

  private async streamResponse(conversationId: string, content: string): Promise<string> {
    const stream: ActiveStream = {
      conversationId, seq: 0, text: '', commitLen: 0, tools: [], parts: [], aborted: false,
    }
    this.activeStreams.set(conversationId, stream)
    let sawDone = false

    try {
      for await (const event of runAgent({ env: this.env, conversationId }, content)) {
        if (stream.aborted) break
        stream.seq++
        switch (event.type) {
          case 'text': {
            stream.text += event.content
            // Append to the current text part so tools stay where they were used.
            const last = stream.parts[stream.parts.length - 1]
            if (last && last.type === 'text') last.content += event.content
            else stream.parts.push({ type: 'text', content: event.content })
            this.broadcast({ type: 'text', conversationId, seq: stream.seq, content: event.content })
            break
          }
          case 'commit':
            // Prior rounds' text is now final; a later reset can't roll past it.
            stream.commitLen = stream.text.length
            break
          case 'reset':
            // Discard only the truncated current round's text; keep committed rounds.
            stream.text = stream.text.slice(0, stream.commitLen)
            if (stream.parts.length && stream.parts[stream.parts.length - 1].type === 'text') stream.parts.pop()
            this.broadcast({ type: 'stream:reset', conversationId, seq: stream.seq })
            break
          case 'tool_start':
            stream.tools.push({ id: event.id, name: event.name, label: event.label })
            stream.parts.push({ type: 'tool', id: event.id, name: event.name, label: event.label })
            this.broadcast({ type: 'tool_start', conversationId, seq: stream.seq, id: event.id, name: event.name, label: event.label })
            break
          case 'tool_result': {
            const tool = stream.tools.find(t => t.id === event.id)
            if (tool) tool.result = event.result
            const p = stream.parts.find(x => x.type === 'tool' && x.id === event.id)
            if (p && p.type === 'tool') p.result = event.result
            this.broadcast({ type: 'tool_result', conversationId, seq: stream.seq, id: event.id, result: event.result })
            break
          }
          case 'done':
            sawDone = true
            await this.saveAssistant(conversationId, stream.text || '*(no response)*', stream.parts, event.usage)
            this.broadcast({ type: 'done', conversationId, seq: stream.seq, usage: event.usage })
            break
          case 'error':
            this.broadcast({ type: 'error', conversationId, seq: stream.seq, message: event.message })
            break
        }
      }

      // Stop: persist whatever we had so it isn't lost, and close the stream out.
      // Only if we didn't already save on `done` - avoids a double message.
      if (stream.aborted && !sawDone && stream.text.trim()) {
        stream.parts.push({ type: 'text', content: '\n\n*(stopped)*' })
        await this.saveAssistant(conversationId, stream.text + '\n\n*(stopped)*', stream.parts)
        stream.seq++
        this.broadcast({ type: 'done', conversationId, seq: stream.seq })
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : 'Agent error'
      stream.seq++
      this.broadcast({ type: 'error', conversationId, seq: stream.seq, message: errMsg })
      // Keep any committed text (earlier rounds) rather than losing it to the error.
      const hadText = stream.text.trim().length > 0
      if (hadText) stream.parts.push({ type: 'text', content: `\n\n*(error: ${errMsg})*` })
      const finalContent = hadText ? `${stream.text}\n\n*(error: ${errMsg})*` : `*Error: ${errMsg}*`
      await this.saveAssistant(conversationId, finalContent, hadText ? stream.parts : undefined).catch(() => {})
    } finally {
      this.activeStreams.delete(conversationId)
    }

    return stream.text
  }

  private async saveAssistant(
    conversationId: string, content: string,
    parts?: StreamPart[], usage?: { input: number; output: number }
  ): Promise<void> {
    await this.env.DB.prepare(
      `INSERT INTO messages (conversation_id, role, content, parts, usage_input, usage_output)
       VALUES (?, 'assistant', ?, ?, ?, ?)`
    ).bind(
      conversationId, content,
      parts && parts.length ? JSON.stringify(parts) : null,
      usage?.input ?? null, usage?.output ?? null,
    ).run()
    await this.env.DB.prepare(
      `UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`
    ).bind(conversationId).run()
  }

  private handleStop(conversationId: string) {
    const stream = this.activeStreams.get(conversationId)
    if (stream) stream.aborted = true
  }

  private async postStreamWork(conversationId: string, userMessage: string, assistantText: string) {
    try {
      // Name the thread from its first exchange. Keyed on title IS NULL so a fast
      // follow-up can't skip titling by pushing the message count past a window.
      const conv = await this.env.DB.prepare(
        `SELECT title FROM conversations WHERE id = ?`
      ).bind(conversationId).first<{ title: string | null }>()
      if (conv && !conv.title && assistantText.trim()) {
        const title = await generateTitle(this.env, userMessage, assistantText)
        await this.env.DB.prepare(
          `UPDATE conversations SET title = ?, topic = ? WHERE id = ?`
        ).bind(title, title, conversationId).run()
        this.broadcast({ type: 'conv:title', conversationId, title, topic: title })
      }

      // The same Angel decides what to remember, then both pyramids roll up. Each
      // step is isolated so one failure never blocks the others. LLM calls are
      // individually timeout-bounded (llm.ts) and builds are capped per run.
      try { await runMemoryPass(this.env, conversationId) }
      catch (e) { console.error('[postStreamWork:memory-pass]', e instanceof Error ? e.message : e) }
      try { await buildObservationPyramid(this.env) }
      catch (e) { console.error('[postStreamWork:obs-pyramid]', e instanceof Error ? e.message : e) }
      try { await buildStreamPyramid(this.env) }
      catch (e) { console.error('[postStreamWork:stream-pyramid]', e instanceof Error ? e.message : e) }
    } catch (e) {
      console.error('[postStreamWork] failed:', e instanceof Error ? e.message : e)
    }
  }

  // --- WebSocket helpers ---

  private send(ws: WebSocket, msg: ServerMsg) {
    try {
      ws.send(JSON.stringify(msg))
    } catch {
      // socket may be closing
    }
  }

  private broadcast(msg: ServerMsg) {
    const sockets = this.state.getWebSockets()
    const data = JSON.stringify(msg)
    for (const ws of sockets) {
      const att = ws.deserializeAttachment() as WsAttachment | null
      if (att?.authed) {
        try { ws.send(data) } catch {}
      }
    }
  }
}
