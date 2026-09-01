import type {
  Env, ClientMsg, ServerMsg, StreamSnapshot,
  MessageRow, StreamPart,
  WallPinRow, AgentInfo, DmMessageRow,
} from './types'
import { runAgent, runMemoryPass } from './agent'
import { readRoomMessages, postRoomMessage } from './chatroom'
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
  timeoutId?: number // pending auth-timeout timer, cleared on successful auth
}

// Only parts a saved reply should carry: text, and tools that actually finished.
// A tool announced but never resolved (stop, error, truncation) would render as
// completed after a reload.
function completedParts(parts: StreamPart[]): StreamPart[] {
  return parts.filter(p => p.type === 'text' || (p.type === 'tool' && p.result !== undefined))
}

export class AngelDO implements DurableObject {
  private state: DurableObjectState
  private env: Env
  private activeStreams = new Map<string, ActiveStream>()
  // Responses stream one at a time (one linear stream); memory work runs on its
  // own serialized chain so it never blocks the next response.
  private responseChain: Promise<void> = Promise.resolve()
  private memoryChain: Promise<void> = Promise.resolve()
  // clientMsgId -> saved message id, so a resend after a dropped confirmation
  // (reconnect replay) doesn't insert the message and run the agent twice.
  // In-memory only: a DO restart clears it, which just reopens the tiny window.
  private processedClientMsgs = new Map<string, number>()

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

      // Auth timeout: close if not authenticated within 10s
      const timeoutId = setTimeout(() => {
        const att = server.deserializeAttachment() as WsAttachment | null
        if (!att?.authed) {
          this.send(server, { type: 'auth:fail' })
          server.close(4001, 'Auth timeout')
        }
      }, 10_000) as unknown as number
      server.serializeAttachment({ authed: false, timeoutId } satisfies WsAttachment)

      return new Response(null, { status: 101, webSocket: client })
    }

    // Internal HTTP API for MCP server writes (triggers WebSocket broadcast)
    if (request.method === 'POST') {
      if (url.pathname === '/api/room/post') {
        const { author, content } = await request.json() as { author: string; content: string }
        const clean = (content || '').trim()
        if (!clean) return Response.json({ error: 'empty' }, { status: 400 })
        const msg = await postRoomMessage(this.env, author, clean)
        this.broadcast({ type: 'room:new', message: msg })
        return Response.json({ ok: true, message: msg })
      }
      if (url.pathname === '/api/wall/pin') {
        const { messageId, pinnedBy, reason } = await request.json() as { messageId: number; pinnedBy: string; reason: string }
        try {
          await this.env.DB.prepare(
            `INSERT INTO wall_pins (message_id, pinned_by, reason) VALUES (?, ?, ?)`
          ).bind(messageId, pinnedBy, reason || '').run()
        } catch (e: unknown) {
          if (e instanceof Error && e.message.includes('UNIQUE'))
            return Response.json({ error: 'already pinned' }, { status: 409 })
          throw e
        }
        const row = await this.env.DB.prepare(
          `SELECT w.id, w.message_id, w.pinned_by, w.reason, w.created_at,
                  m.author, m.content, m.created_at AS message_created_at
           FROM wall_pins w JOIN chatroom_messages m ON m.id = w.message_id
           WHERE w.id = (SELECT MAX(id) FROM wall_pins WHERE message_id = ? AND pinned_by = ?)`
        ).bind(messageId, pinnedBy).first<WallPinRow>()
        if (row) this.broadcast({ type: 'wall:pinned', pin: row })
        return Response.json({ ok: true, pin: row })
      }
      if (url.pathname === '/api/wall/unpin') {
        const { messageId, pinnedBy } = await request.json() as { messageId: number; pinnedBy?: string }
        const result = pinnedBy
          ? await this.env.DB.prepare(
              `DELETE FROM wall_pins WHERE message_id = ? AND pinned_by = ?`
            ).bind(messageId, pinnedBy).run()
          : await this.env.DB.prepare(
              `DELETE FROM wall_pins WHERE message_id = ?`
            ).bind(messageId).run()
        const remaining = await this.env.DB.prepare(
          `SELECT COUNT(*) as cnt FROM wall_pins WHERE message_id = ?`
        ).bind(messageId).first<{ cnt: number }>()
        if (result.meta.changes && (!remaining || remaining.cnt === 0)) {
          this.broadcast({ type: 'wall:unpinned', messageId })
        } else if (result.meta.changes) {
          const rows = await this.env.DB.prepare(AngelDO.WALL_QUERY).all<WallPinRow>()
          this.broadcast({ type: 'wall:pins', pins: rows.results || [] })
        }
        return Response.json({ ok: true, removed: !!result.meta.changes })
      }
      if (url.pathname === '/api/dm/post') {
        const { agent_id, author, content } = await request.json() as { agent_id: string; author: string; content: string }
        const clean = (content || '').trim()
        if (!clean) return Response.json({ error: 'empty' }, { status: 400 })
        const result = await this.env.DB.prepare(
          `INSERT INTO dm_messages (agent_id, author, content) VALUES (?, ?, ?)`
        ).bind(agent_id, author, clean).run()
        const msg: DmMessageRow = {
          id: result.meta.last_row_id, agent_id, author, content: clean,
          created_at: new Date().toISOString(),
        }
        this.broadcast({ type: 'dm:new', agentId: agent_id, message: msg })
        // Immediate wake if Eli is messaging an agent
        if (author === 'eli') {
          const preview = clean.slice(0, 80)
          await this.env.DB.prepare(
            `INSERT INTO agent_wakeups (agent_id, wake_at, reason)
             VALUES (?, datetime('now'), ?)
             ON CONFLICT(agent_id) DO UPDATE SET wake_at = datetime('now'), reason = excluded.reason, created_at = datetime('now')`
          ).bind(agent_id, `DM from Eli: ${preview}`).run()
          await this.syncAlarm()
        }
        return Response.json({ ok: true, message: msg })
      }
      if (url.pathname === '/api/sync-alarm') {
        await this.syncAlarm()
        return Response.json({ ok: true })
      }
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

    const att = ws.deserializeAttachment() as WsAttachment | null

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

      case 'dm:load':
        await this.handleDmLoad(ws, msg.agentId, msg.since)
        break

      case 'dm:post':
        await this.handleDmPost(msg.agentId, msg.content)
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

  private async resolveAgent(conversationId: string): Promise<{ agentId: string; agentName: string; agentModel: string | null } | null> {
    const row = await this.env.DB.prepare(
      `SELECT a.id, a.name, a.model FROM conversations c JOIN agents a ON a.id = c.agent_id WHERE c.id = ?`
    ).bind(conversationId).first<{ id: string; name: string; model: string | null }>()
    return row ? { agentId: row.id, agentName: row.name, agentModel: row.model } : null
  }

  // How much history a conversation load ships to the client. The DM is the
  // agent's entire merged stream, so an unbounded load grows forever; older
  // history stays reachable to the agent through the pyramid.
  private static readonly CONV_LOAD_LIMIT = 300

  private async handleConvLoad(ws: WebSocket, conversationId: string) {
    const rows = await this.env.DB.prepare(
      `SELECT * FROM (
         SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?
       ) ORDER BY id ASC`
    ).bind(conversationId, AngelDO.CONV_LOAD_LIMIT).all<MessageRow>()

    const stream = this.activeStreams.get(conversationId)
    // The in-progress reply is progressively saved to D1, so it can already be
    // in `rows`; the client renders it from the stream snapshot instead, and
    // sending both would show the same reply twice.
    const messages = stream?.savedMsgId
      ? rows.results.filter(m => m.id !== stream.savedMsgId)
      : rows.results
    const snapshot: StreamSnapshot | undefined = stream
      ? { conversationId, seq: stream.seq, text: stream.text, tools: stream.tools, parts: stream.parts }
      : undefined

    this.send(ws, {
      type: 'conv:messages',
      conversationId,
      messages,
      stream: snapshot,
    })
  }

  private async handleChat(conversationId: string, clientMsgId: string, content: string) {
    // Replay after a dropped confirmation: re-confirm to the client, run nothing.
    const dupId = this.processedClientMsgs.get(clientMsgId)
    if (dupId !== undefined) {
      this.broadcast({ type: 'msg:user', conversationId, clientMsgId, messageId: dupId, content })
      return
    }

    const agent = await this.resolveAgent(conversationId)
    if (!agent) {
      console.error('[handleChat] no agent for conversation:', conversationId)
      return
    }

    try {
      const messageId = await this.saveUserMessage(conversationId, content, clientMsgId)
      this.processedClientMsgs.set(clientMsgId, messageId)
      if (this.processedClientMsgs.size > 300) {
        const oldest = this.processedClientMsgs.keys().next().value
        if (oldest) this.processedClientMsgs.delete(oldest)
      }
    } catch (e) {
      console.error('[handleChat] save user message failed:', e instanceof Error ? e.message : e)
      return
    }

    await this.runTurn(conversationId, agent.agentId, agent.agentName, agent.agentModel, content)
  }

  private async touchConversation(conversationId: string): Promise<void> {
    await this.env.DB.prepare(
      `UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`
    ).bind(conversationId).run()
  }

  // Persist a user-side message (Eli's, or a system-injected one), touch the
  // conversation, and broadcast it to connected clients.
  private async saveUserMessage(conversationId: string, content: string, clientMsgId: string): Promise<number> {
    const result = await this.env.DB.prepare(
      `INSERT INTO messages (conversation_id, role, content) VALUES (?, 'user', ?)`
    ).bind(conversationId, content).run()
    await this.touchConversation(conversationId)
    this.broadcast({
      type: 'msg:user', conversationId, clientMsgId,
      messageId: result.meta.last_row_id, content,
    })
    return result.meta.last_row_id
  }

  // Run a full turn for a saved user-side message: the streamed response on the
  // response chain, then the memory work on its own serialized chain.
  private async runTurn(conversationId: string, agentId: string, agentName: string, agentModel: string | null, content: string): Promise<void> {
    const respLink = this.responseChain.then(() => this.streamResponse(conversationId, agentId, agentName, agentModel, content))
    this.responseChain = respLink.then(() => {}, () => {})
    try { await respLink }
    catch (e) { console.error('[runTurn] response failed:', e instanceof Error ? e.message : e) }

    const memLink = this.memoryChain.then(() => this.postStreamWork(conversationId, agentId, agentName, agentModel))
    this.memoryChain = memLink.then(() => {}, () => {})
    try { await memLink }
    catch (e) { console.error('[runTurn] memory failed:', e instanceof Error ? e.message : e) }

    // The agent may have (re)scheduled a wake-up during this turn - re-arm the
    // DO alarm on every turn path (chat, wake-up, restart recovery).
    await this.syncAlarm().catch(e => console.error('[runTurn] syncAlarm failed:', e instanceof Error ? e.message : e))
  }

  private async streamResponse(conversationId: string, agentId: string, agentName: string, agentModel: string | null, content: string): Promise<string> {
    const stream: ActiveStream = {
      conversationId, seq: 0, text: '', commitLen: 0, commitPartLen: 0, savedLen: 0, tools: [], parts: [], aborted: false, savedMsgId: null,
    }
    this.activeStreams.set(conversationId, stream)
    await this.state.storage.put(`streaming:${conversationId}`, agentId)
    let sawDone = false
    this.log('info', 'stream:start', `agent=${agentName}`, agentId, conversationId)

    try {
      const agentCtx = {
        env: this.env, conversationId, agentId, agentName, agentModel,
        broadcast: (msg: ServerMsg) => this.broadcast(msg),
      }
      for await (const event of runAgent(agentCtx, content)) {
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
              completedParts(stream.parts),
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
      // Only save if we didn't already on `done` (avoids a double message), but
      // ALWAYS broadcast done - even a stop with nothing streamed yet must
      // release the client from its streaming state.
      if (stream.aborted && !sawDone) {
        this.log('warn', 'stream:aborted', `textLen=${stream.text.length} savedMsgId=${stream.savedMsgId}`, agentId, conversationId)
        if (stream.text.trim()) {
          stream.parts.push({ type: 'text', content: '\n\n*(stopped)*' })
          await this.saveAssistant(conversationId, stream.text + '\n\n*(stopped)*', completedParts(stream.parts), undefined, stream.savedMsgId)
        }
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
      await this.saveAssistant(conversationId, finalContent, hadText ? completedParts(stream.parts) : undefined, undefined, stream.savedMsgId).catch(() => {})
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
      const message = e instanceof Error ? e.message : 'Failed to store document'
      console.error('[handleDocAdd]', message)
      // Tell the client - otherwise the pending chip spins forever and blocks sending.
      this.broadcast({ type: 'doc:error', conversationId, clientDocId, message })
    }
  }

  private async postStreamWork(conversationId: string, agentId: string, agentName: string, agentModel: string | null) {
    try { await runMemoryPass({ env: this.env, conversationId, agentId, agentName, agentModel }) }
    catch (e) { console.error('[postStreamWork:memory-pass]', e instanceof Error ? e.message : e) }
    try { await buildObservationPyramid(this.env, agentId) }
    catch (e) { console.error('[postStreamWork:obs-pyramid]', e instanceof Error ? e.message : e) }
    try { await buildStreamPyramid(this.env, agentId, conversationId) }
    catch (e) { console.error('[postStreamWork:stream-pyramid]', e instanceof Error ? e.message : e) }
  }

  // --- Chatroom ---

  private async handleRoomLoad(ws: WebSocket, since?: string) {
    const messages = await readRoomMessages(this.env, since, 100)
    this.send(ws, { type: 'room:messages', messages })
  }

  private async handleRoomPost(content: string) {
    const clean = content.trim()
    if (!clean) return
    const msg = await postRoomMessage(this.env, 'eli', clean)
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
    await this.broadcastWallState()
  }

  private async handleWallUnpin(messageId: number) {
    await this.env.DB.prepare(
      `DELETE FROM wall_pins WHERE message_id = ? AND pinned_by = 'eli'`
    ).bind(messageId).run()
    await this.broadcastWallState()
  }

  private async broadcastWallState() {
    const rows = await this.env.DB.prepare(AngelDO.WALL_QUERY).all<WallPinRow>()
    this.broadcast({ type: 'wall:pins', pins: rows.results || [] })
  }

  // --- DMs ---

  private async handleDmLoad(ws: WebSocket, agentId: string, since?: string) {
    let rows
    if (since) {
      rows = await this.env.DB.prepare(
        `SELECT id, agent_id, author, content, created_at FROM dm_messages WHERE agent_id = ? AND created_at > ? ORDER BY created_at ASC LIMIT 200`
      ).bind(agentId, since).all<DmMessageRow>()
    } else {
      rows = await this.env.DB.prepare(
        `SELECT id, agent_id, author, content, created_at FROM dm_messages WHERE agent_id = ? ORDER BY created_at DESC LIMIT 100`
      ).bind(agentId).all<DmMessageRow>()
      if (rows.results) rows.results.reverse()
    }
    this.send(ws, { type: 'dm:messages', agentId, messages: rows.results || [] })
  }

  private async handleDmPost(agentId: string, content: string) {
    const clean = content.trim()
    if (!clean) return
    const result = await this.env.DB.prepare(
      `INSERT INTO dm_messages (agent_id, author, content) VALUES (?, 'eli', ?)`
    ).bind(agentId, clean).run()
    const msg: DmMessageRow = {
      id: result.meta.last_row_id, agent_id: agentId, author: 'eli',
      content: clean, created_at: new Date().toISOString(),
    }
    this.broadcast({ type: 'dm:new', agentId, message: msg })
    // Immediate agent wake
    const preview = clean.slice(0, 80)
    await this.env.DB.prepare(
      `INSERT INTO agent_wakeups (agent_id, wake_at, reason)
       VALUES (?, datetime('now'), ?)
       ON CONFLICT(agent_id) DO UPDATE SET wake_at = datetime('now'), reason = excluded.reason, created_at = datetime('now')`
    ).bind(agentId, `DM from Eli: ${preview}`).run()
    await this.syncAlarm()
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
          `SELECT name, model FROM agents WHERE id = ?`
        ).bind(agentId).first<{ name: string; model: string | null }>()
        if (!agent) continue

        const sysContent = '<system>You were interrupted mid-response by a restart. Review the conversation and continue where you left off.</system>'
        await this.saveUserMessage(conversationId, sysContent, `restart-${agentId}-${Date.now()}`)
        await this.runTurn(conversationId, agentId, agent.name, agent.model, sysContent)
      } catch (e) {
        console.error('[resumeInterrupted] failed for', agentId, e instanceof Error ? e.message : e)
      }
    }
  }

  // --- Alarm: agent wake-ups ---

  private async syncAlarm(): Promise<void> {
    // Bootstrap: ensure agents with cadence have a wakeup row
    const orphans = await this.env.DB.prepare(
      `SELECT a.id as agent_id, a.cadence_minutes
       FROM agents a
       LEFT JOIN agent_wakeups w ON w.agent_id = a.id
       WHERE a.cadence_minutes IS NOT NULL AND a.cadence_minutes > 0 AND w.agent_id IS NULL`
    ).all<{ agent_id: string; cadence_minutes: number }>()

    for (const o of orphans.results) {
      const nextWake = new Date(Date.now() + o.cadence_minutes * 60_000).toISOString()
      await this.env.DB.prepare(
        `INSERT INTO agent_wakeups (agent_id, wake_at, reason)
         VALUES (?, ?, 'cadence check-in')`
      ).bind(o.agent_id, nextWake).run()
    }

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
      `SELECT w.agent_id, w.reason, a.name as agent_name, a.model as agent_model, a.cadence_minutes, c.id as conversation_id
       FROM agent_wakeups w
       JOIN agents a ON a.id = w.agent_id
       JOIN conversations c ON c.agent_id = w.agent_id
       WHERE w.wake_at <= ?
       ORDER BY w.wake_at ASC`
    ).bind(now).all<{ agent_id: string; reason: string | null; agent_name: string; agent_model: string | null; cadence_minutes: number | null; conversation_id: string }>()

    for (const row of due.results) {
      await this.env.DB.prepare(
        `DELETE FROM agent_wakeups WHERE agent_id = ?`
      ).bind(row.agent_id).run()

      // Auto-schedule next cadence-driven wakeup before running the agent
      if (row.cadence_minutes && row.cadence_minutes > 0) {
        const nextWake = new Date(Date.now() + row.cadence_minutes * 60_000).toISOString()
        await this.env.DB.prepare(
          `INSERT INTO agent_wakeups (agent_id, wake_at, reason)
           VALUES (?, ?, 'cadence check-in')
           ON CONFLICT(agent_id) DO UPDATE SET wake_at = excluded.wake_at, reason = excluded.reason, created_at = datetime('now')`
        ).bind(row.agent_id, nextWake).run()
      }

      const reason = row.reason || 'scheduled check-in'
      const sysContent = `<system>Wake up — ${reason}</system>`
      try {
        await this.saveUserMessage(row.conversation_id, sysContent, `wakeup-${row.agent_id}-${Date.now()}`)
        await this.runTurn(row.conversation_id, row.agent_id, row.agent_name, row.agent_model, sysContent)
      } catch (e) {
        console.error('[alarm] wake-up failed for', row.agent_id, e instanceof Error ? e.message : e)
      }
    }

    // Also check for agents with cadence but no wakeup scheduled (bootstrap)
    const orphans = await this.env.DB.prepare(
      `SELECT a.id as agent_id, a.cadence_minutes
       FROM agents a
       LEFT JOIN agent_wakeups w ON w.agent_id = a.id
       WHERE a.cadence_minutes IS NOT NULL AND a.cadence_minutes > 0 AND w.agent_id IS NULL`
    ).all<{ agent_id: string; cadence_minutes: number }>()

    for (const o of orphans.results) {
      const nextWake = new Date(Date.now() + o.cadence_minutes * 60_000).toISOString()
      await this.env.DB.prepare(
        `INSERT INTO agent_wakeups (agent_id, wake_at, reason)
         VALUES (?, ?, 'cadence check-in')`
      ).bind(o.agent_id, nextWake).run()
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
