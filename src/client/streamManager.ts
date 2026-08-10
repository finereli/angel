import type {
  ClientMsg, ServerMsg, ConversationRow, MessageRow, StreamSnapshot
} from '../worker/types'

export type ConnState = 'disconnected' | 'connecting' | 'authenticating' | 'connected' | 'reconnecting'

export type StreamState = 'idle' | 'streaming'

export type StreamPart =
  | { type: 'text'; content: string }
  | { type: 'tool'; id: string; name: string; label: string; result?: string }

export interface ConversationState {
  messages: MessageRow[]
  streamState: StreamState
  streamParts: StreamPart[]
  streamSeq: number
  error: string | null
}

type Listener = () => void

let nextMsgKey = -1

class AngelClient {
  private ws: WebSocket | null = null
  private pin: string = ''
  private connState: ConnState = 'disconnected'
  private conversations: ConversationRow[] = []
  private convStates = new Map<string, ConversationState>()
  private listeners = new Set<Listener>()
  private reconnectDelay = 1000
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingInterval: ReturnType<typeof setInterval> | null = null
  private pongTimeout: ReturnType<typeof setTimeout> | null = null
  private pendingSend: { conversationId: string; content: string; clientMsgId: string } | null = null
  private conversationsLoaded = false

  getConnState(): ConnState { return this.connState }
  getConversations(): ConversationRow[] { return this.conversations }
  hasLoadedConversations(): boolean { return this.conversationsLoaded }

  getConvState(id: string): ConversationState {
    if (!this.convStates.has(id)) {
      this.convStates.set(id, {
        messages: [],
        streamState: 'idle',
        streamParts: [],
        streamSeq: 0,
        error: null,
      })
    }
    return this.convStates.get(id)!
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private notify() {
    for (const fn of this.listeners) {
      try { fn() } catch {}
    }
  }

  connect(pin: string) {
    this.pin = pin
    this.doConnect()
  }

  disconnect() {
    this.connState = 'disconnected'
    this.stopPing()
    this.clearReconnectTimer()
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect')
      this.ws = null
    }
    this.notify()
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private doConnect() {
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }

    this.connState = 'connecting'
    this.notify()

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    this.ws = new WebSocket(`${proto}//${location.host}/ws`)

    this.ws.onopen = () => {
      this.connState = 'authenticating'
      this.notify()
      this.send({ type: 'auth', pin: this.pin })
    }

    this.ws.onmessage = (event) => {
      let msg: ServerMsg
      try { msg = JSON.parse(event.data) } catch { return }
      this.handleMessage(msg)
    }

    this.ws.onclose = () => {
      this.stopPing()
      if (this.connState !== 'disconnected') {
        this.connState = 'reconnecting'
        this.notify()
        this.clearReconnectTimer()
        this.reconnectTimer = setTimeout(() => {
          if (this.connState === 'reconnecting') {
            this.doConnect()
          }
        }, this.reconnectDelay)
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000)
      }
    }

    this.ws.onerror = () => {}
  }

  private handleMessage(msg: ServerMsg) {
    switch (msg.type) {
      case 'auth:ok': {
        this.connState = 'connected'
        this.reconnectDelay = 1000
        this.startPing()
        const activeIds = new Set(msg.activeStreams.map(s => s.conversationId))
        for (const snapshot of msg.activeStreams) {
          const state = this.getConvState(snapshot.conversationId)
          state.streamState = 'streaming'
          state.streamParts = rebuildPartsFromSnapshot(snapshot)
          state.streamSeq = snapshot.seq
        }
        for (const [convId, state] of this.convStates) {
          if (state.streamState === 'streaming' && !activeIds.has(convId)) {
            state.streamState = 'idle'
            state.streamParts = []
            state.streamSeq = 0
            this.send({ type: 'conv:load', conversationId: convId })
          }
        }
        // Retry pending send
        if (this.pendingSend) {
          this.send({
            type: 'chat',
            conversationId: this.pendingSend.conversationId,
            clientMsgId: this.pendingSend.clientMsgId,
            content: this.pendingSend.content,
          })
        }
        this.send({ type: 'conv:list' })
        this.notify()
        break
      }

      case 'auth:fail':
        this.connState = 'disconnected'
        this.notify()
        break

      case 'pong':
        if (this.pongTimeout) {
          clearTimeout(this.pongTimeout)
          this.pongTimeout = null
        }
        break

      case 'conv:list':
        this.conversations = msg.conversations
        this.conversationsLoaded = true
        this.notify()
        break

      case 'conv:created':
        this.conversations = [{
          id: msg.conversationId,
          title: null,
          topic: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          archived: 0,
          source: 'web',
        }, ...this.conversations]
        this.notify()
        break

      case 'conv:archived':
        this.conversations = this.conversations.map(c =>
          c.id === msg.conversationId ? { ...c, archived: 1 } : c
        )
        this.notify()
        break

      case 'conv:unarchived':
        this.conversations = this.conversations.map(c =>
          c.id === msg.conversationId ? { ...c, archived: 0 } : c
        )
        this.notify()
        break

      case 'conv:messages': {
        const state = this.getConvState(msg.conversationId)
        state.messages = msg.messages
        if (msg.stream) {
          state.streamState = 'streaming'
          state.streamParts = rebuildPartsFromSnapshot(msg.stream)
          state.streamSeq = msg.stream.seq
        }
        this.notify()
        break
      }

      case 'conv:title': {
        this.conversations = this.conversations.map(c =>
          c.id === msg.conversationId ? { ...c, title: msg.title } : c
        )
        this.notify()
        break
      }

      case 'msg:user': {
        const state = this.getConvState(msg.conversationId)
        const confirmed: MessageRow = {
          id: msg.messageId,
          conversation_id: msg.conversationId,
          role: 'user',
          content: msg.content,
          created_at: new Date().toISOString(),
          tool_calls: null,
          tool_call_id: null,
          usage_input: null,
          usage_output: null,
          parts: null,
        }
        const optIdx = state.messages.findIndex(m => m.id < 0 && m.role === 'user')
        if (optIdx >= 0) {
          state.messages = [...state.messages]
          state.messages[optIdx] = confirmed
        } else {
          state.messages = [...state.messages, confirmed]
        }
        this.pendingSend = null
        this.notify()
        break
      }

      case 'stream:reset': {
        // A truncated attempt was discarded server-side. The server sends the
        // authoritative parts back to the last committed boundary.
        const state = this.getConvState(msg.conversationId)
        state.streamParts = msg.parts as StreamPart[]
        state.streamSeq = msg.seq
        state.streamState = 'streaming'
        this.notify()
        break
      }

      case 'text': {
        const state = this.getConvState(msg.conversationId)
        if (msg.seq > state.streamSeq) {
          state.streamState = 'streaming'
          const parts = state.streamParts
          const last = parts[parts.length - 1]
          if (last && last.type === 'text') {
            last.content += msg.content
          } else {
            parts.push({ type: 'text', content: msg.content })
          }
          state.streamParts = [...parts]
          state.streamSeq = msg.seq
          this.notify()
        }
        break
      }

      case 'tool_start': {
        const state = this.getConvState(msg.conversationId)
        if (msg.seq > state.streamSeq) {
          state.streamState = 'streaming'
          state.streamParts = [...state.streamParts, {
            type: 'tool', id: msg.id, name: msg.name, label: msg.label,
          }]
          state.streamSeq = msg.seq
          this.notify()
        }
        break
      }

      case 'tool_result': {
        const state = this.getConvState(msg.conversationId)
        if (msg.seq > state.streamSeq) {
          state.streamParts = state.streamParts.map(p =>
            p.type === 'tool' && p.id === msg.id ? { ...p, result: msg.result } : p
          )
          state.streamSeq = msg.seq
          this.notify()
        }
        break
      }

      case 'done': {
        const state = this.getConvState(msg.conversationId)
        // Drop any tool announced but never completed (truncated tail).
        const parts = state.streamParts.filter(p => p.type === 'text' || (p.type === 'tool' && p.result !== undefined))
        const text = parts.filter(p => p.type === 'text').map(p => (p as { content: string }).content).join('')
        if (parts.length > 0) {
          state.messages = [...state.messages, {
            id: nextMsgKey--,
            conversation_id: msg.conversationId,
            role: 'assistant',
            content: text,
            created_at: new Date().toISOString(),
            tool_calls: null,
            tool_call_id: null,
            usage_input: msg.usage?.input ?? null,
            usage_output: msg.usage?.output ?? null,
            parts: JSON.stringify(parts), // keep tools where they were used
          }]
        }
        state.streamState = 'idle'
        state.streamParts = []
        state.streamSeq = 0
        this.notify()
        break
      }

      case 'error': {
        const state = this.getConvState(msg.conversationId)
        const parts: StreamPart[] = [...state.streamParts]
        const text = parts.filter(p => p.type === 'text').map(p => (p as { content: string }).content).join('')
        if (parts.length > 0) {
          parts.push({ type: 'text', content: `\n\n*Error: ${msg.message}*` })
          state.messages = [...state.messages, {
            id: nextMsgKey--,
            conversation_id: msg.conversationId,
            role: 'assistant',
            content: text + `\n\n*Error: ${msg.message}*`,
            created_at: new Date().toISOString(),
            tool_calls: null,
            tool_call_id: null,
            usage_input: null,
            usage_output: null,
            parts: JSON.stringify(parts),
          }]
        }
        state.streamState = 'idle'
        state.streamParts = []
        state.streamSeq = 0
        state.error = msg.message
        setTimeout(() => {
          if (state.error === msg.message) {
            state.error = null
            this.notify()
          }
        }, 8000)
        this.notify()
        break
      }
    }
  }

  sendChat(conversationId: string, content: string) {
    const clientMsgId = crypto.randomUUID()

    const state = this.getConvState(conversationId)
    state.messages = [...state.messages, {
      id: nextMsgKey--,
      conversation_id: conversationId,
      role: 'user',
      content,
      created_at: new Date().toISOString(),
      tool_calls: null,
      tool_call_id: null,
      usage_input: null,
      usage_output: null,
      parts: null,
    }]
    state.streamState = 'streaming'
    state.streamParts = []
    state.streamSeq = 0
    state.error = null

    this.pendingSend = { conversationId, content, clientMsgId }
    this.notify()

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({ type: 'chat', conversationId, clientMsgId, content })
    }
  }

  createConversation() {
    this.send({ type: 'conv:create' })
  }

  archiveConversation(id: string) {
    this.send({ type: 'conv:archive', conversationId: id })
  }

  renameConversation(id: string, title: string) {
    this.send({ type: 'conv:rename', conversationId: id, title })
  }

  unarchiveConversation(id: string) {
    this.send({ type: 'conv:unarchive', conversationId: id })
  }

  loadConversation(id: string) {
    this.send({ type: 'conv:load', conversationId: id })
  }

  stopStream(conversationId: string) {
    this.send({ type: 'stop', conversationId })
  }

  private send(msg: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  private startPing() {
    this.stopPing()
    // Tighter heartbeat: a silent drop surfaces in ~15s worst case instead of ~35s.
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.send({ type: 'ping', ts: Date.now() })
        if (!this.pongTimeout) {
          this.pongTimeout = setTimeout(() => {
            this.pongTimeout = null
            this.ws?.close()
          }, 5_000)
        }
      }
    }, 10_000)
  }

  private stopPing() {
    if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null }
    if (this.pongTimeout) { clearTimeout(this.pongTimeout); this.pongTimeout = null }
  }

  // The browser knows the network died before any heartbeat can: reflect it instantly.
  private handleOffline() {
    if (this.connState === 'connected' || this.connState === 'connecting' || this.connState === 'authenticating') {
      this.connState = 'reconnecting'
      this.stopPing()
      if (this.ws) { try { this.ws.close() } catch {} this.ws = null }
      this.notify()
    }
  }

  private handleOnline() {
    if (this.pin && this.connState !== 'connected' && this.connState !== 'connecting' && this.connState !== 'authenticating') {
      this.clearReconnectTimer()
      this.reconnectDelay = 1000
      this.doConnect()
    }
  }
}

function rebuildPartsFromSnapshot(snapshot: StreamSnapshot): StreamPart[] {
  // Prefer the ordered parts so tools reconnect where they were used.
  if (snapshot.parts && snapshot.parts.length) return snapshot.parts as StreamPart[]
  const parts: StreamPart[] = []
  if (snapshot.text) parts.push({ type: 'text', content: snapshot.text })
  for (const tool of snapshot.tools) {
    parts.push({ type: 'tool', id: tool.id, name: tool.name, label: tool.label, result: tool.result })
  }
  return parts
}

export const angel = new AngelClient()

// Visibility-change reconnect: bypass throttled timers on mobile
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    if (angel.getConnState() === 'reconnecting') {
      angel['clearReconnectTimer']()
      angel['doConnect']()
    }
  })
}

// Network up/down: the fastest possible signal, faster than any heartbeat.
if (typeof window !== 'undefined') {
  window.addEventListener('offline', () => angel['handleOffline']())
  window.addEventListener('online', () => angel['handleOnline']())
}
