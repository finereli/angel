import type {
  Env, ClientMsg, ServerMsg, StreamSnapshot,
  MessageRow, AgentEvent, StreamPart,
  ChatroomMessageRow, WallPinRow, AgentInfo,
} from './types'
import { runAgent, runMemoryPass } from './agent'
import { storeDocument, normalizeContent } from './documents'
import { buildObservationPyramid } from './memory'
import { buildStreamPyramid } from './stream-pyramid'

interface ActiveStream {
  conversationId: string
  seq: number
  text: string
  commitLen: number // length of `text` committed by prior tool rounds (reset floor)
  commitPartLen: number // count of `parts` committed by prior rounds (reset floor)
  savedLen: number // length of `text` last flushed to D1 (periodic-save watermark, NOT the reset floor)
  tools: Array<{ id: string; name: string; label: string; result?: string }>
  parts: StreamPart[] // ordered text/tool parts, as the reply is rendered
  aborted: boolean
  savedMsgId: number | null // D1 row id once the in-progress message has been persisted
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
    this.state.blockConcurrencyWhile(async () => {
      await this.syncAlarm().catch(e => console.error('[syncAlarm] init failed:', e))
      await this.resumeInterrupted().catch(e => console.error('[resumeInterrupted] init failed:', e))
    })
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/ws') {
      const upgrade = request.headers.get('Upgrade')
      if (upgrade !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 })
      }

      const pair = new WebSocketPair()
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket]

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
        const agents = await this.loadAgents()
        this.send(ws, { type: 'auth:ok', activeStreams: snapshots, agents })
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

      case 'conv:load':
        await this.handleConvLoad(ws, msg.conversationId)
        break

      case 'chat':
        await this.handleChat(msg.conversationId, msg.clientMsgId, msg.content)
        break

      case 'doc:add':
        await this.handleDocAdd(msg.conversationId, msg.clientDocId, msg.title, msg.content)
        break

      case 'stop':
        this.handleStop(msg.conversationId)
        break

      case 'room:load':
        await this.handleRoomLoad(ws, msg.since)
        break

      case 'room:post':
        await this.handleRoomPost(msg.content)
        break

      case 'wall:load':
        await this.handleWallLoad(ws)
        break

      case 'wall:pin':
        await this.handleWallPin(ws, msg.messageId, msg.reason)
        break

      case 'wall:unpin':
        await this.handleWallUnpin(msg.messageId)
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

  private async loadAgents(): Promise<AgentInfo[]> {
    const rows = await this.env.DB.prepare(
      `SELECT a.id, a.name, c.id as conversation_id
       FROM agents a JOIN conversations c ON c.agent_id = a.id
       ORDER BY a.created_at`
    ).all<{ id: string; name: string; conversation_id: string }>()
    return rows.results.map(r => ({ id: r.id, name: r.name, conversationId: r.conversation_id }))
  }

  private async resolveAgent(conversationId: string): Promise<{ agentId: string; agentName: string } | null> {
    const row = await this.env.DB.prepare(
      `SELECT a.id, a.name FROM conversations c JOIN agents a ON a.id = c.agent_id WHERE c.id = ?`
    ).bind(conversationId).first<{ id: string; name: string }>()
    return row ? { agentId: row.id, agentName: row.name } : null
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
    const agent = await this.resolveAgent(conversationId)
    if (!agent) {
      console.error('[handleChat] no agent for conversation:', conversationId)
      return
    }

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

    const { agentId, agentName } = agent
    const respLink = this.responseChain.then(() => this.streamResponse(conversationId, agentId, agentName, content))
    this.responseChain = respLink.then(() => {}, () => {})
    let assistantText = ''
    try { assistantText = await respLink }
    catch (e) { console.error('[handleChat] response failed:', e instanceof Error ? e.message : e) }

    const memLink = this.memoryChain.then(() => this.postStreamWork(conversationId, agentId, agentName, content, assistantText))
    this.memoryChain = memLink.then(() => {}, () => {})
    try { await memLink }
    catch (e) { console.error('[handleChat] memory failed:', e instanceof Error ? e.message : e) }

    await this.syncAlarm()
  }

  private async streamResponse(conversationId: string, agentId: string, agentName: string, content: string): Promise<string> {
    const stream: ActiveStream = {
      conversationId, seq: 0, text: '', commitLen: 0, commitPartLen: 0, savedLen: 0, tools: [], parts: [], aborted: false, savedMsgId: null,
    }
    this.activeStreams.set(conversationId, stream)
    await this.state.storage.put(`streaming:${conversationId}`, agentId)
    let sawDone = false
    this.log('info', 'stream:start', `agent=${agentName}`, agentId, conversationId)

    try {
      for await (const event of runAgent({ env: this.env, conversationId, agentId, agentName }, content)) {
        if (stream.aborted) break
        stream.seq++
        switch (event.type) {
          case 'text': {
            stream.text += event.content
            const last = stream.parts[stream.parts.length - 1]
            if (last && last.type === 'text') last.content += event.content
            else stream.parts.push({ type: 'text', content: event.content })
            this.broadcast({ type: 'text', conversationId, seq: stream.seq, content: event.content })
            // Periodic save: flush to D1 every ~200 chars of unsaved text so a
            // DO eviction doesn't lose the entire final round. This must NOT
            // touch commitLen/commitPartLen - those are the retry rollback
            // floor, and moving them mid-round would make a reset keep partial
            // text from the failed attempt.
            if (stream.text.length - stream.savedLen >= 200 && stream.text.trim()) {
              stream.savedLen = stream.text.length
              stream.savedMsgId = await this.saveAssistant(
                conversationId, stream.text, stream.parts, undefined, stream.savedMsgId,
              )
            }
            break
          }
          case 'commit':
            stream.commitLen = stream.text.length
            stream.commitPartLen = stream.parts.length
            if (stream.text.trim()) {
              stream.savedLen = stream.text.length
              stream.savedMsgId = await this.saveAssistant(
                conversationId, stream.text, stream.parts, undefined, stream.savedMsgId,
              )
            }
            break
          case 'reset':
            this.log('warn', 'stream:reset', `textLen=${stream.text.length} commitLen=${stream.commitLen}`, agentId, conversationId)
            stream.text = stream.text.slice(0, stream.commitLen)
            stream.parts = stream.parts.slice(0, stream.commitPartLen)
            stream.tools = stream.parts
              .filter((p): p is Extract<StreamPart, { type: 'tool' }> => p.type === 'tool')
              .map(p => ({ id: p.id, name: p.name, label: p.label, result: p.result }))
            // If a periodic save already flushed discarded text, overwrite it
            // with the trimmed truth so an eviction can't resurrect it.
            if (stream.savedMsgId && stream.savedLen > stream.text.length) {
              await this.saveAssistant(conversationId, stream.text, stream.parts, undefined, stream.savedMsgId)
            }
            stream.savedLen = Math.min(stream.savedLen, stream.text.length)
            this.broadcast({ type: 'stream:reset', conversationId, seq: stream.seq, parts: stream.parts })
            break
          case 'tool_start':
            stream.tools.push({ id: event.id, name: event.name, label: event.label })
            stream.parts.push({ type: 'tool', id: event.id, name: event.name, label: event.label })
            this.broadcast({ type: 'tool_start', conversationId, seq: stream.seq, id: event.id, name: event.name, label: event.label })
            break
          case 'tool_result': {
            const tool = stream.tools.find(t => t.id === event.id)
            if (tool) { tool.result = event.result; tool.label = event.label }
            const p = stream.parts.find(x => x.type === 'tool' && x.id === event.id)
            if (p && p.type === 'tool') { p.result = event.result; p.label = event.label }
            this.broadcast({ type: 'tool_result', conversationId, seq: stream.seq, id: event.id, result: event.result, label: event.label })
            if (stream.savedMsgId) {
              await this.saveAssistant(conversationId, stream.text, stream.parts, undefined, stream.savedMsgId)
            }
            break
          }
          case 'done':
            sawDone = true
            this.log('info', 'stream:done', `textLen=${stream.text.length} parts=${stream.parts.length} usage=${event.usage?.input}/${event.usage?.output} finish=${event.finishReason ?? '?'}`, agentId, conversationId)
            stream.savedMsgId = await this.saveAssistant(
              conversationId, stream.text || '*(no response)*',
              stream.parts.filter(p => p.type === 'text' || (p.type === 'tool' && p.result !== undefined)),
              event.usage, stream.savedMsgId,
            )
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
        this.log('warn', 'stream:aborted', `textLen=${stream.text.length} savedMsgId=${stream.savedMsgId}`, agentId, conversationId)
        stream.parts.push({ type: 'text', content: '\n\n*(stopped)*' })
        await this.saveAssistant(conversationId, stream.text + '\n\n*(stopped)*', stream.parts, undefined, stream.savedMsgId)
        stream.seq++
        this.broadcast({ type: 'done', conversationId, seq: stream.seq })
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : 'Agent error'
      this.log('error', 'stream:error', `err=${errMsg} textLen=${stream.text.length} savedMsgId=${stream.savedMsgId}`, agentId, conversationId)
      stream.seq++
      this.broadcast({ type: 'error', conversationId, seq: stream.seq, message: errMsg })
      const hadText = stream.text.trim().length > 0
      if (hadText) stream.parts.push({ type: 'text', content: `\n\n*(error: ${errMsg})*` })
      const finalContent = hadText ? `${stream.text}\n\n*(error: ${errMsg})*` : `*Error: ${errMsg}*`
      await this.saveAssistant(conversationId, finalContent, hadText ? stream.parts : undefined, undefined, stream.savedMsgId).catch(() => {})
    } finally {
      this.activeStreams.delete(conversationId)
      await this.state.storage.delete(`streaming:${conversationId}`)
    }

    return stream.text
  }

  private async saveAssistant(
    conversationId: string, content: string,
    parts?: StreamPart[], usage?: { input: number; output: number },
    existingMsgId?: number | null,
  ): Promise<number> {
    const partsJson = parts && parts.length ? JSON.stringify(parts) : null
    let msgId: number
    if (existingMsgId) {
      await this.env.DB.prepare(
        `UPDATE messages SET content = ?, parts = ?, usage_input = ?, usage_output = ? WHERE id = ?`
      ).bind(content, partsJson, usage?.input ?? null, usage?.output ?? null, existingMsgId).run()
      msgId = existingMsgId
    } else {
      const result = await this.env.DB.prepare(
        `INSERT INTO messages (conversation_id, role, content, parts, usage_input, usage_output)
         VALUES (?, 'assistant', ?, ?, ?, ?)`
      ).bind(conversationId, content, partsJson, usage?.input ?? null, usage?.output ?? null).run()
      msgId = result.meta.last_row_id
    }
    await this.env.DB.prepare(
      `UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`
    ).bind(conversationId).run()
    return msgId
  }

  private handleStop(conversationId: string) {
    const stream = this.activeStreams.get(conversationId)
    if (stream) stream.aborted = true
  }

  // Store a document out of context. Angel learns it exists via the context note
  // (see formatDocsNote) and reads it with the read_document tool.
  private async handleDocAdd(conversationId: string, clientDocId: string, title: string, content: string) {
    try {
      const text = normalizeContent(content, title)
      const meta = await storeDocument(this.env, conversationId, title || 'Untitled document', text)
      this.broadcast({ type: 'doc:added', conversationId, clientDocId, id: meta.id, title: meta.title, lineCount: meta.line_count })
    } catch (e) {
      console.error('[handleDocAdd]', e instanceof Error ? e.message : e)
    }
  }

  private async postStreamWork(conversationId: string, agentId: string, agentName: string, _userMessage: string, _assistantText: string) {
    try { await runMemoryPass(this.env, agentId, agentName, conversationId) }
    catch (e) { console.error('[postStreamWork:memory-pass]', e instanceof Error ? e.message : e) }
    try { await buildObservationPyramid(this.env, agentId) }
    catch (e) { console.error('[postStreamWork:obs-pyramid]', e instanceof Error ? e.message : e) }
    try { await buildStreamPyramid(this.env, agentId, conversationId) }
    catch (e) { console.error('[postStreamWork:stream-pyramid]', e instanceof Error ? e.message : e) }
  }

  // --- Chatroom ---

  private async handleRoomLoad(ws: WebSocket, since?: string) {
    let rows
    if (since) {
      rows = await this.env.DB.prepare(
        `SELECT id, author, content, created_at FROM chatroom_messages WHERE created_at > ? ORDER BY created_at ASC LIMIT 200`
      ).bind(since).all<ChatroomMessageRow>()
    } else {
      rows = await this.env.DB.prepare(
        `SELECT id, author, content, created_at FROM chatroom_messages ORDER BY created_at DESC LIMIT 100`
      ).all<ChatroomMessageRow>()
      if (rows.results) rows.results.reverse()
    }
    this.send(ws, { type: 'room:messages', messages: rows.results || [] })
  }

  private async handleRoomPost(content: string) {
    const clean = content.trim()
    if (!clean) return
    const result = await this.env.DB.prepare(
      `INSERT INTO chatroom_messages (author, content) VALUES (?, ?)`
    ).bind('eli', clean).run()
    const msg: ChatroomMessageRow = {
      id: result.meta.last_row_id,
      author: 'eli',
      content: clean,
      created_at: new Date().toISOString(),
    }
    this.broadcast({ type: 'room:new', message: msg })
  }

  // --- Wall ---

  private static readonly WALL_QUERY = `
    SELECT w.id, w.message_id, w.pinned_by, w.reason, w.created_at,
           m.author, m.content, m.created_at AS message_created_at
    FROM wall_pins w
    JOIN chatroom_messages m ON m.id = w.message_id
    ORDER BY w.created_at ASC`

  private async handleWallLoad(ws: WebSocket) {
    const rows = await this.env.DB.prepare(AngelDO.WALL_QUERY)
      .all<WallPinRow>()
    this.send(ws, { type: 'wall:pins', pins: rows.results || [] })
  }

  private async handleWallPin(ws: WebSocket, messageId: number, reason?: string) {
    try {
      await this.env.DB.prepare(
        `INSERT INTO wall_pins (message_id, pinned_by, reason) VALUES (?, ?, ?)`
      ).bind(messageId, 'eli', reason || '').run()
    } catch (e: unknown) {
      if (e instanceof Error && e.message.includes('UNIQUE')) return
      throw e
    }
    const row = await this.env.DB.prepare(
      `SELECT w.id, w.message_id, w.pinned_by, w.reason, w.created_at,
              m.author, m.content, m.created_at AS message_created_at
       FROM wall_pins w JOIN chatroom_messages m ON m.id = w.message_id
       WHERE w.message_id = ?`
    ).bind(messageId).first<WallPinRow>()
    if (row) this.broadcast({ type: 'wall:pinned', pin: row })
  }

  private async handleWallUnpin(messageId: number) {
    await this.env.DB.prepare(
      `DELETE FROM wall_pins WHERE message_id = ?`
    ).bind(messageId).run()
    this.broadcast({ type: 'wall:unpinned', messageId })
  }

  // --- Restart recovery ---

  private async resumeInterrupted(): Promise<void> {
    const stored = await this.state.storage.list<string>({ prefix: 'streaming:' })
    if (stored.size === 0) return

    // Collect interrupted agents and clear the flags synchronously (inside
    // blockConcurrencyWhile), then kick off responses asynchronously so we
    // don't block the fetch that woke the DO.
    const interrupted: Array<{ conversationId: string; agentId: string }> = []
    for (const [key, agentId] of stored) {
      interrupted.push({ conversationId: key.slice('streaming:'.length), agentId })
      await this.state.storage.delete(key)
    }

    // Fire the actual recovery outside blockConcurrencyWhile
    setTimeout(() => this.runRecovery(interrupted), 0)
  }

  private async runRecovery(interrupted: Array<{ conversationId: string; agentId: string }>): Promise<void> {
    for (const { conversationId, agentId } of interrupted) {
      try {
        const agent = await this.env.DB.prepare(
          `SELECT name FROM agents WHERE id = ?`
        ).bind(agentId).first<{ name: string }>()
        if (!agent) continue

        const sysContent = '<system>You were interrupted mid-response by a restart. Review the conversation and continue where you left off.</system>'

        const result = await this.env.DB.prepare(
          `INSERT INTO messages (conversation_id, role, content) VALUES (?, 'user', ?)`
        ).bind(conversationId, sysContent).run()
        await this.env.DB.prepare(
          `UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`
        ).bind(conversationId).run()

        this.broadcast({
          type: 'msg:user',
          conversationId,
          clientMsgId: `restart-${agentId}-${Date.now()}`,
          messageId: result.meta.last_row_id,
          content: sysContent,
        })

        const respLink = this.responseChain.then(
          () => this.streamResponse(conversationId, agentId, agent.name, sysContent)
        )
        this.responseChain = respLink.then(() => {}, () => {})
        let assistantText = ''
        try { assistantText = await respLink }
        catch (e) { console.error('[resumeInterrupted] response failed:', e instanceof Error ? e.message : e) }

        const memLink = this.memoryChain.then(
          () => this.postStreamWork(conversationId, agentId, agent.name, sysContent, assistantText)
        )
        this.memoryChain = memLink.then(() => {}, () => {})
        try { await memLink }
        catch (e) { console.error('[resumeInterrupted] memory failed:', e instanceof Error ? e.message : e) }
      } catch (e) {
        console.error('[resumeInterrupted] failed for', agentId, e instanceof Error ? e.message : e)
      }
    }
  }

  // --- Alarm: agent wake-ups ---

  private async syncAlarm(): Promise<void> {
    const next = await this.env.DB.prepare(
      `SELECT wake_at FROM agent_wakeups ORDER BY wake_at ASC LIMIT 1`
    ).first<{ wake_at: string }>()
    if (next) {
      const when = new Date(next.wake_at.endsWith('Z') ? next.wake_at : next.wake_at + 'Z')
      const current = await this.state.storage.getAlarm()
      if (!current || Math.abs(when.getTime() - current) > 30_000) {
        await this.state.storage.setAlarm(when)
      }
    } else {
      await this.state.storage.deleteAlarm()
    }
  }

  async alarm(): Promise<void> {
    const now = new Date().toISOString()
    const due = await this.env.DB.prepare(
      `SELECT w.agent_id, w.reason, a.name as agent_name, c.id as conversation_id
       FROM agent_wakeups w
       JOIN agents a ON a.id = w.agent_id
       JOIN conversations c ON c.agent_id = w.agent_id
       WHERE w.wake_at <= ?
       ORDER BY w.wake_at ASC`
    ).bind(now).all<{ agent_id: string; reason: string | null; agent_name: string; conversation_id: string }>()

    for (const row of due.results) {
      await this.env.DB.prepare(
        `DELETE FROM agent_wakeups WHERE agent_id = ?`
      ).bind(row.agent_id).run()

      const reason = row.reason || 'scheduled check-in'
      const sysContent = `<system>Wake up — ${reason}</system>`

      const result = await this.env.DB.prepare(
        `INSERT INTO messages (conversation_id, role, content) VALUES (?, 'user', ?)`
      ).bind(row.conversation_id, sysContent).run()
      await this.env.DB.prepare(
        `UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`
      ).bind(row.conversation_id).run()

      this.broadcast({
        type: 'msg:user',
        conversationId: row.conversation_id,
        clientMsgId: `wakeup-${row.agent_id}-${Date.now()}`,
        messageId: result.meta.last_row_id,
        content: sysContent,
      })

      const respLink = this.responseChain.then(
        () => this.streamResponse(row.conversation_id, row.agent_id, row.agent_name, sysContent)
      )
      this.responseChain = respLink.then(() => {}, () => {})
      let assistantText = ''
      try { assistantText = await respLink }
      catch (e) { console.error('[alarm] response failed:', e instanceof Error ? e.message : e) }

      const memLink = this.memoryChain.then(
        () => this.postStreamWork(row.conversation_id, row.agent_id, row.agent_name, sysContent, assistantText)
      )
      this.memoryChain = memLink.then(() => {}, () => {})
      try { await memLink }
      catch (e) { console.error('[alarm] memory failed:', e instanceof Error ? e.message : e) }
    }

    await this.syncAlarm()
  }

  // --- Logging ---

  private log(level: 'info' | 'warn' | 'error', event: string, detail?: string, agentId?: string, conversationId?: string) {
    this.env.DB.prepare(
      `INSERT INTO agent_logs (agent_id, conversation_id, level, event, detail) VALUES (?, ?, ?, ?, ?)`
    ).bind(agentId || null, conversationId || null, level, event, detail || null).run().catch(() => {})
    if (level === 'error') console.error(`[${event}]`, detail)
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
