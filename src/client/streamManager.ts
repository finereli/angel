import type {
  ClientMsg, ServerMsg, MessageRow, StreamSnapshot,
  ChatroomMessageRow, WallPinRow, AgentInfo,
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
  streamStartTime: number // ms epoch the current stream began; 0 when idle
  error: string | null
}

type Listener = () => void
export interface DocAdded { conversationId: string; clientDocId: string; id: string; title: string; lineCount: number }
type DocListener = (d: DocAdded) => void
type RoomListener = () => void

let nextMsgKey = -1

class AngelClient {
  private ws: WebSocket | null = null
  private pin: string = ''
  private connState: ConnState = 'disconnected'
  private agents: AgentInfo[] = []
  private convStates = new Map<string, ConversationState>()
  private listeners = new Set<Listener>()
  private docListeners = new Set<DocListener>()
  private roomListeners = new Set<RoomListener>()
  private roomMessages: ChatroomMessageRow[] = []
  private roomLoaded = false
  private newRoomIds = new Set<number>()
  private wallListeners = new Set<RoomListener>()
  private wallPins: WallPinRow[] = []
  private reconnectDelay = 1000
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingInterval: ReturnType<typeof setInterval> | null = null
  private pongTimeout: ReturnType<typeof setTimeout> | null = null
  private pendingSend: { conversationId: string; content: string; clientMsgId: string } | null = null
  private agentsLoaded = false
  private loadedConversations = new Set<string>()

  getConnState(): ConnState { return this.connState }
  getAgents(): AgentInfo[] { return this.agents }
  hasLoadedAgents(): boolean { return this.agentsLoaded }
  getRoomMessages(): ChatroomMessageRow[] { return this.roomMessages }
  isRoomLoaded(): boolean { return this.roomLoaded }
  consumeNewRoomIds(): Set<number> {
    const ids = this.newRoomIds
    this.newRoomIds = new Set()
    return ids
  }
  getWallPins(): WallPinRow[] { return this.wallPins }

  getConvState(id: string): ConversationState {
    if (!this.convStates.has(id)) {
      this.convStates.set(id, {
        messages: [],
        streamState: 'idle',
        streamParts: [],
        streamSeq: 0,
        streamStartTime: 0,
        error: null,
      })
    }
    return this.convStates.get(id)!
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  // A stored document resolved server-side (its real id is now known).
  onDocAdded(fn: DocListener): () => void {
    this.docListeners.add(fn)
    return () => this.docListeners.delete(fn)
  }

  onRoomUpdate(fn: RoomListener): () => void {
    this.roomListeners.add(fn)
    return () => this.roomListeners.delete(fn)
  }

  onWallUpdate(fn: RoomListener): () => void {
    this.wallListeners.add(fn)
    return () => this.wallListeners.delete(fn)
  }

  private notifyRoom() {
    for (const fn of this.roomListeners) {
      try { fn() } catch {}
    }
  }

  private notifyWall() {
    for (const fn of this.wallListeners) {
      try { fn() } catch {}
    }
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
    this.loadedConversations.clear()
    this.roomLoaded = false
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
      this.loadedConversations.clear()
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
        this.agents = msg.agents
        this.agentsLoaded = true
        const activeIds = new Set(msg.activeStreams.map(s => s.conversationId))
        for (const snapshot of msg.activeStreams) {
          const state = this.getConvState(snapshot.conversationId)
          state.streamState = 'streaming'
          if (!state.streamStartTime) state.streamStartTime = Date.now()
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
        if (this.pendingSend) {
          this.send({
            type: 'chat',
            conversationId: this.pendingSend.conversationId,
            clientMsgId: this.pendingSend.clientMsgId,
            content: this.pendingSend.content,
          })
        }
        // Eagerly load all conversations so switching is instant
        for (const agent of msg.agents) {
          if (!this.loadedConversations.has(agent.conversationId)) {
            this.send({ type: 'conv:load', conversationId: agent.conversationId })
          }
        }
        this.send({ type: 'room:load' })
        this.send({ type: 'wall:load' })
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

      case 'conv:messages': {
        const state = this.getConvState(msg.conversationId)
        state.messages = msg.messages
        this.loadedConversations.add(msg.conversationId)
        if (msg.stream) {
          state.streamState = 'streaming'
          if (!state.streamStartTime) state.streamStartTime = Date.now()
          state.streamParts = rebuildPartsFromSnapshot(msg.stream)
          state.streamSeq = msg.stream.seq
        }
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
        if (!state.streamStartTime) state.streamStartTime = Date.now()
        this.notify()
        break
      }

      case 'text': {
        const state = this.getConvState(msg.conversationId)
        if (msg.seq > state.streamSeq) {
          state.streamState = 'streaming'
          if (!state.streamStartTime) state.streamStartTime = Date.now()
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
          if (!state.streamStartTime) state.streamStartTime = Date.now()
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
            p.type === 'tool' && p.id === msg.id ? { ...p, result: msg.result, label: msg.label || p.label } : p
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
        state.streamStartTime = 0
        this.notify()
        break
      }

      case 'room:messages': {
        const prevIds = new Set(this.roomMessages.map(m => m.id))
        this.roomMessages = msg.messages
        this.roomLoaded = true
        if (prevIds.size > 0) {
          this.newRoomIds = new Set(msg.messages.filter(m => !prevIds.has(m.id)).map(m => m.id))
        }
        this.notifyRoom()
        break
      }

      case 'room:new':
        this.roomMessages = [...this.roomMessages, msg.message]
        this.notifyRoom()
        break

      case 'wall:pins':
        this.wallPins = msg.pins
        this.notifyWall()
        break

      case 'wall:pinned':
        this.wallPins = [...this.wallPins, msg.pin]
        this.notifyWall()
        break

      case 'wall:unpinned':
        this.wallPins = this.wallPins.filter(p => p.message_id !== msg.messageId)
        this.notifyWall()
        break

      case 'doc:added': {
        for (const fn of this.docListeners) {
          try { fn(msg) } catch {}
        }
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
        state.streamStartTime = 0
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
    state.streamStartTime = Date.now()
    state.error = null

    this.pendingSend = { conversationId, content, clientMsgId }
    this.notify()

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({ type: 'chat', conversationId, clientMsgId, content })
    }
  }

  // Store a long attachment as an out-of-context document. The real id comes back
  // via onDocAdded, keyed by clientDocId.
  addDocument(conversationId: string, clientDocId: string, title: string, content: string) {
    this.send({ type: 'doc:add', conversationId, clientDocId, title, content })
  }

  loadConversation(id: string) {
    if (this.loadedConversations.has(id)) {
      // Already loaded — serve from cache, notify to trigger re-render
      this.notify()
      return
    }
    this.send({ type: 'conv:load', conversationId: id })
  }

  stopStream(conversationId: string) {
    this.send({ type: 'stop', conversationId })
  }

  loadRoom(since?: string) {
    this.send({ type: 'room:load', since })
  }

  postToRoom(content: string) {
    this.send({ type: 'room:post', content })
  }

  loadWall() {
    this.send({ type: 'wall:load' })
  }

  pinToWall(messageId: number, reason?: string) {
    this.send({ type: 'wall:pin', messageId, reason })
  }

  unpinFromWall(messageId: number) {
    this.send({ type: 'wall:unpin', messageId })
  }

  isOnWall(messageId: number): boolean {
    return this.wallPins.some(p => p.message_id === messageId)
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
