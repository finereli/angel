import type {
  Env, ClientMsg, ServerMsg, StreamSnapshot,
  MessageRow, StreamPart, AgentInfo, ConversationRow,
} from './types'
import { runAgent, runMemoryPass } from './agent'
import { storeDocument, normalizeContent } from './documents'
import { buildObservationPyramid } from './memory'
import { buildStreamPyramid } from './stream-pyramid'
import { getConversation, conversationInfo, renderSeedText } from './conversation-context'
import { isKnownModel, isReasoningEffort } from './models'

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
  // Turns queued behind the response chain but not yet streaming, per
  // conversation. Lets a reconnecting client show "responding..." for a reply
  // that is coming but hasn't produced its first event yet.
  private pendingTurns = new Map<string, number>()

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

    // Internal HTTP API for the MCP server (cadence changes re-arm the alarm).
    if (request.method === 'POST' && url.pathname === '/api/sync-alarm') {
      await this.syncAlarm()
      return Response.json({ ok: true })
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
        const agent = await this.loadAgent()
        this.send(ws, {
          type: 'auth:ok', activeStreams: snapshots, agent,
          pendingTurns: Array.from(this.pendingTurns.keys()),
        })
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

      case 'conv:list':
        await this.handleConvList(ws)
        break

      case 'conv:create-side':
        await this.handleCreateSide(ws, msg.title)
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

      case 'settings:set':
        await this.handleSettingsSet(ws, msg.model, msg.reasoningEffort)
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

  // The one agent and the conversation the client opens on. The schema keeps
  // both tables generic; the UI just never asks for more than the first row.
  private async loadAgent(): Promise<AgentInfo | null> {
    const row = await this.env.DB.prepare(
      `SELECT a.id, a.name, a.model, a.reasoning_effort, c.id as conversation_id
       FROM agents a JOIN conversations c ON c.agent_id = a.id
       WHERE c.parent_id IS NULL
       ORDER BY a.created_at, c.created_at LIMIT 1`
    ).first<{ id: string; name: string; model: string | null; reasoning_effort: string | null; conversation_id: string }>()
    return row
      ? { id: row.id, name: row.name, conversationId: row.conversation_id, model: row.model, reasoningEffort: row.reasoning_effort }
      : null
  }

  private async handleConvList(ws: WebSocket) {
    const agent = await this.loadAgent()
    if (!agent) return
    const rows = await this.env.DB.prepare(
      `SELECT * FROM conversations WHERE agent_id = ? AND archived = 0 ORDER BY created_at`
    ).bind(agent.id).all<ConversationRow>()
    this.send(ws, { type: 'conv:list', conversations: rows.results.map(conversationInfo) })
  }

  // A side conversation: branch off the main line with a frozen render of it.
  private async handleCreateSide(ws: WebSocket, title: string) {
    const agent = await this.loadAgent()
    if (!agent) return
    const seed = await renderSeedText(this.env, agent.id, agent.conversationId)
    const id = `side-${crypto.randomUUID().slice(0, 8)}`
    const cleanTitle = (title || '').trim() || `Side chat ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`
    await this.env.DB.prepare(
      `INSERT INTO conversations (id, title, agent_id, parent_id, seed, seed_at, source)
       VALUES (?, ?, ?, ?, ?, ?, 'web')`
    ).bind(id, cleanTitle, agent.id, agent.conversationId, seed, new Date().toISOString()).run()
    const row = await getConversation(this.env, id)
    if (row) this.broadcast({ type: 'conv:created', conversation: conversationInfo(row) })
  }

  private async handleSettingsSet(ws: WebSocket, model: string | null, reasoningEffort: string | null) {
    if (model !== null && !isKnownModel(model)) {
      this.send(ws, { type: 'settings:error', message: `Unknown model: ${model}` })
      return
    }
    if (reasoningEffort !== null && !isReasoningEffort(reasoningEffort)) {
      this.send(ws, { type: 'settings:error', message: `Unknown reasoning effort: ${reasoningEffort}` })
      return
    }
    const agent = await this.loadAgent()
    if (!agent) return
    await this.env.DB.prepare(`UPDATE agents SET model = ?, reasoning_effort = ? WHERE id = ?`)
      .bind(model, reasoningEffort, agent.id).run()
    this.broadcast({ type: 'agent:updated', agent: { ...agent, model, reasoningEffort } })
  }

  private async resolveAgent(conversationId: string): Promise<{ agentId: string; agentName: string; agentModel: string | null; agentReasoningEffort: string | null } | null> {
    const row = await this.env.DB.prepare(
      `SELECT a.id, a.name, a.model, a.reasoning_effort FROM conversations c JOIN agents a ON a.id = c.agent_id WHERE c.id = ?`
    ).bind(conversationId).first<{ id: string; name: string; model: string | null; reasoning_effort: string | null }>()
    return row ? { agentId: row.id, agentName: row.name, agentModel: row.model, agentReasoningEffort: row.reasoning_effort } : null
  }

  // How much history a conversation load ships to the client. The stream is the
  // agent's entire history, so an unbounded load grows forever; older exchanges
  // stay reachable to the agent through the pyramid.
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
      pending: this.pendingTurns.has(conversationId) || undefined,
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

    await this.runTurn(conversationId, agent.agentId, agent.agentName, agent.agentModel, agent.agentReasoningEffort, content)
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

  private markPending(conversationId: string) {
    this.pendingTurns.set(conversationId, (this.pendingTurns.get(conversationId) || 0) + 1)
  }

  private unmarkPending(conversationId: string) {
    const n = (this.pendingTurns.get(conversationId) || 0) - 1
    if (n <= 0) this.pendingTurns.delete(conversationId)
    else this.pendingTurns.set(conversationId, n)
  }

  // Run a full turn for a saved user-side message: the streamed response on the
  // response chain, then the memory work on its own serialized chain.
  private async runTurn(conversationId: string, agentId: string, agentName: string, agentModel: string | null, agentReasoningEffort: string | null, content: string): Promise<void> {
    this.markPending(conversationId)
    const respLink = this.responseChain.then(() => this.streamResponse(conversationId, agentId, agentName, agentModel, agentReasoningEffort, content))
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

  private async streamResponse(conversationId: string, agentId: string, agentName: string, agentModel: string | null, agentReasoningEffort: string | null, content: string): Promise<string> {
    this.unmarkPending(conversationId) // no longer queued: it's live from here
    const stream: ActiveStream = {
      conversationId, seq: 0, text: '', commitLen: 0, commitPartLen: 0, savedLen: 0, tools: [], parts: [], aborted: false, savedMsgId: null,
    }
    this.activeStreams.set(conversationId, stream)
    await this.state.storage.put(`streaming:${conversationId}`, agentId)
    let sawDone = false
    this.log('info', 'stream:start', `agent=${agentName}`, agentId, conversationId)

    try {
      const agentCtx = {
        env: this.env, conversationId, agentId, agentName, agentModel, agentReasoningEffort,
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
    // Side conversations don't feed the stream pyramid - its tiles are per-agent,
    // so a side's pair indices would collide with the main line's.
    const conv = await getConversation(this.env, conversationId)
    if (conv?.parent_id) return
    try { await buildStreamPyramid(this.env, agentId, conversationId) }
    catch (e) { console.error('[postStreamWork:stream-pyramid]', e instanceof Error ? e.message : e) }
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
          `SELECT name, model, reasoning_effort FROM agents WHERE id = ?`
        ).bind(agentId).first<{ name: string; model: string | null; reasoning_effort: string | null }>()
        if (!agent) continue

        const sysContent = '<system>You were interrupted mid-response by a restart. Review the conversation and continue where you left off.</system>'
        await this.saveUserMessage(conversationId, sysContent, `restart-${agentId}-${Date.now()}`)
        await this.runTurn(conversationId, agentId, agent.name, agent.model, agent.reasoning_effort, sysContent)
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
      `SELECT w.agent_id, w.reason, a.name as agent_name, a.model as agent_model, a.reasoning_effort as agent_reasoning_effort, a.cadence_minutes, c.id as conversation_id
       FROM agent_wakeups w
       JOIN agents a ON a.id = w.agent_id
       JOIN conversations c ON c.agent_id = w.agent_id AND c.parent_id IS NULL
       WHERE w.wake_at <= ?
       ORDER BY w.wake_at ASC`
    ).bind(now).all<{ agent_id: string; reason: string | null; agent_name: string; agent_model: string | null; agent_reasoning_effort: string | null; cadence_minutes: number | null; conversation_id: string }>()

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
        await this.runTurn(row.conversation_id, row.agent_id, row.agent_name, row.agent_model, row.agent_reasoning_effort, sysContent)
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
