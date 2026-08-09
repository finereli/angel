import type {
  Env, ClientMsg, ServerMsg, StreamSnapshot,
  ConversationRow, MessageRow, AgentEvent
} from './types'
import { runAgent, runMemoryPass } from './agent'
import { generateTitle } from './title'
import { buildObservationPyramid } from './memory'
import { buildStreamPyramid } from './stream-pyramid'

interface ActiveStream {
  conversationId: string
  seq: number
  text: string
  tools: Array<{ id: string; name: string; label: string; result?: string }>
  aborted: boolean
}

interface WsAttachment {
  authed: boolean
}

export class AngelDO implements DurableObject {
  private state: DurableObjectState
  private env: Env
  private activeStreams = new Map<string, ActiveStream>()
  // Serializes background memory work: a fast follow-up waits for the prior rollup.
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
      ? { conversationId, seq: stream.seq, text: stream.text, tools: stream.tools }
      : undefined

    this.send(ws, {
      type: 'conv:messages',
      conversationId,
      messages: rows.results,
      stream: snapshot,
    })
  }

  private async handleChat(conversationId: string, clientMsgId: string, content: string) {
    if (this.activeStreams.has(conversationId)) {
      this.broadcast({
        type: 'error',
        conversationId,
        seq: 0,
        message: 'A response is already in progress',
      })
      return
    }

    const stream: ActiveStream = {
      conversationId,
      seq: 0,
      text: '',
      tools: [],
      aborted: false,
    }

    try {
      // Wait for any in-flight memory rollup so context renders from a settled state.
      await this.memoryChain.catch(() => {})

      const result = await this.env.DB.prepare(
        `INSERT INTO messages (conversation_id, role, content) VALUES (?, 'user', ?)`
      ).bind(conversationId, content).run()

      await this.env.DB.prepare(
        `UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`
      ).bind(conversationId).run()

      this.broadcast({
        type: 'msg:user',
        conversationId,
        clientMsgId,
        messageId: result.meta.last_row_id,
        content,
      })

      this.activeStreams.set(conversationId, stream)

      for await (const event of runAgent({ env: this.env, conversationId }, content)) {
        if (stream.aborted) break

        stream.seq++

        switch (event.type) {
          case 'text':
            stream.text += event.content
            this.broadcast({
              type: 'text',
              conversationId,
              seq: stream.seq,
              content: event.content,
            })
            break

          case 'tool_start':
            stream.tools.push({ id: event.id, name: event.name, label: event.label })
            this.broadcast({
              type: 'tool_start',
              conversationId,
              seq: stream.seq,
              id: event.id,
              name: event.name,
              label: event.label,
            })
            break

          case 'tool_result': {
            const tool = stream.tools.find(t => t.id === event.id)
            if (tool) tool.result = event.result
            this.broadcast({
              type: 'tool_result',
              conversationId,
              seq: stream.seq,
              id: event.id,
              result: event.result,
            })
            break
          }

          case 'done':
            this.broadcast({
              type: 'done',
              conversationId,
              seq: stream.seq,
              usage: event.usage,
            })
            break

          case 'error':
            this.broadcast({
              type: 'error',
              conversationId,
              seq: stream.seq,
              message: event.message,
            })
            break
        }
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : 'Agent error'
      stream.seq++
      this.broadcast({
        type: 'error',
        conversationId,
        seq: stream.seq,
        message: errMsg,
      })
      // Save error as assistant message so it persists across reconnects
      await this.env.DB.prepare(
        `INSERT INTO messages (conversation_id, role, content) VALUES (?, 'assistant', ?)`
      ).bind(conversationId, `*Error: ${errMsg}*`).run().catch(() => {})
    } finally {
      this.activeStreams.delete(conversationId)
    }

    this.memoryChain = this.memoryChain
      .then(() => this.postStreamWork(conversationId, content, stream.text))
      .catch(() => {})
    this.state.waitUntil(this.memoryChain)
  }

  private handleStop(conversationId: string) {
    const stream = this.activeStreams.get(conversationId)
    if (stream) stream.aborted = true
  }

  private async postStreamWork(conversationId: string, userMessage: string, assistantText: string) {
    try {
      // Name the thread from its first exchange (title doubles as the topic marker).
      const msgCount = await this.env.DB.prepare(
        `SELECT COUNT(*) as c FROM messages WHERE conversation_id = ?`
      ).bind(conversationId).first<{ c: number }>()

      if (msgCount && msgCount.c <= 3) {
        const title = await generateTitle(this.env, userMessage, assistantText)
        await this.env.DB.prepare(
          `UPDATE conversations SET title = ?, topic = ? WHERE id = ?`
        ).bind(title, title, conversationId).run()
        this.broadcast({ type: 'conv:title', conversationId, title, topic: title })
      }

      // The same Angel, in parallel, decides what to remember. Then roll up both pyramids.
      await runMemoryPass(this.env, conversationId)
      await buildObservationPyramid(this.env)
      await buildStreamPyramid(this.env)
    } catch {
      // background failures are non-fatal
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
