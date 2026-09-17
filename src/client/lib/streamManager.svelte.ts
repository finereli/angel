import type {
  ClientMsg, ServerMsg, MessageRow, StreamSnapshot, StreamPart, AgentInfo, ConversationInfo,
} from '../../worker/types'

export type { StreamPart }

export type ConnState = 'disconnected' | 'connecting' | 'authenticating' | 'connected' | 'reconnecting'

export type StreamState = 'idle' | 'streaming'

export interface ConversationState {
  messages: MessageRow[]
  streamState: StreamState
  streamParts: StreamPart[]
  streamSeq: number
  streamStartTime: number // ms epoch the current stream began; 0 when idle
  error: string | null
}

// A document upload's resolution: its server-side id, or an error.
export interface DocAdded {
  conversationId: string
  clientDocId: string
  id?: string
  title?: string
  lineCount?: number
  error?: string
}
type DocListener = (d: DocAdded) => void

const PIN_KEY = 'angel.pin.v1'

let nextMsgKey = -1

// A locally-constructed message row (optimistic user echo, or an assistant reply
// assembled from stream parts) with the DB-only fields nulled out.
function localMessage(
  conversationId: string, role: 'user' | 'assistant', content: string,
  extra: Partial<MessageRow> = {},
): MessageRow {
  return {
    id: nextMsgKey--,
    conversation_id: conversationId,
    role,
    content,
    created_at: new Date().toISOString(),
    tool_calls: null,
    tool_call_id: null,
    usage_input: null,
    usage_output: null,
    parts: null,
    ...extra,
  }
}

// The one WebSocket client. State is rune-based, so components read `angel.x`
// directly and re-render; there is no subscribe() layer. The PIN is the
// credential (kit pin-auth convention): stored raw, replayed on every connect,
// cleared when the server rejects it.
class AngelClient {
  pin = $state<string | null>(null)
  connState = $state<ConnState>('disconnected')
  agent = $state<AgentInfo | null>(null)
  agentLoaded = $state(false)
  settingsError = $state<string | null>(null)
  convStates = $state<Record<string, ConversationState>>({})
  conversations = $state<ConversationInfo[]>([])

  #ws: WebSocket | null = null
  #docListeners = new Set<DocListener>()
  #reconnectDelay = 1000
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null
  #pingInterval: ReturnType<typeof setInterval> | null = null
  #pongTimeout: ReturnType<typeof setTimeout> | null = null
  #pendingSend: { conversationId: string; content: string; clientMsgId: string } | null = null
  #loadedConversations = new Set<string>()
  #pinResolve: ((ok: boolean) => void) | null = null
  #candidatePin: string | null = null
  #createResolve: ((id: string) => void) | null = null

  constructor() {
    // Visibility-change reconnect: bypass throttled timers on mobile.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return
        if (this.connState === 'reconnecting') {
          this.clearReconnectTimer()
          this.doConnect()
        }
      })
    }
    // Network up/down: the fastest possible signal, faster than any heartbeat.
    if (typeof window !== 'undefined') {
      window.addEventListener('offline', () => this.handleOffline())
      window.addEventListener('online', () => this.handleOnline())
    }
  }

  get signedIn(): boolean { return this.pin !== null }

  get mainConversationId(): string | null { return this.agent?.conversationId ?? null }

  // Optimistic boot: a stored PIN shows the app immediately; the first
  // auth:fail clears it and drops back to the keypad.
  boot() {
    const saved = localStorage.getItem(PIN_KEY)
    if (saved) {
      this.pin = saved
      this.doConnect()
    }
  }

  // PIN keypad submit: connect and resolve true only once the server accepts.
  // The candidate is not promoted to `pin` until auth:ok, so the keypad stays
  // mounted (and can shake) while the check is in flight.
  submit(pin: string): Promise<boolean> {
    this.#candidatePin = pin
    return new Promise((resolve) => {
      this.#pinResolve = resolve
      this.doConnect()
      setTimeout(() => {
        if (this.#pinResolve === resolve) {
          this.#pinResolve = null
          this.#candidatePin = null
          resolve(false)
        }
      }, 8000)
    })
  }

  signOut() {
    localStorage.removeItem(PIN_KEY)
    this.disconnect()
    this.pin = null
  }

  getConvState(id: string): ConversationState {
    if (!this.convStates[id]) {
      this.convStates[id] = {
        messages: [],
        streamState: 'idle',
        streamParts: [],
        streamSeq: 0,
        streamStartTime: 0,
        error: null,
      }
    }
    return this.convStates[id]
  }

  updateSettings(model: string | null, reasoningEffort: string | null) {
    this.settingsError = null
    this.send({ type: 'settings:set', model, reasoningEffort })
  }

  // A stored document resolved server-side (its real id is now known).
  onDocAdded(fn: DocListener): () => void {
    this.#docListeners.add(fn)
    return () => this.#docListeners.delete(fn)
  }

  disconnect() {
    this.connState = 'disconnected'
    this.stopPing()
    this.clearReconnectTimer()
    this.#loadedConversations.clear()
    if (this.#ws) {
      this.#ws.close(1000, 'Client disconnect')
      this.#ws = null
    }
  }

  private clearReconnectTimer() {
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer)
      this.#reconnectTimer = null
    }
  }

  private doConnect() {
    if (this.#ws) {
      this.#ws.close()
      this.#ws = null
    }

    this.connState = 'connecting'

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    this.#ws = new WebSocket(`${proto}//${location.host}/ws`)

    this.#ws.onopen = () => {
      this.connState = 'authenticating'
      this.send({ type: 'auth', pin: this.pin ?? this.#candidatePin ?? '' })
    }

    this.#ws.onmessage = (event) => {
      let msg: ServerMsg
      try { msg = JSON.parse(event.data) } catch { return }
      this.handleMessage(msg)
    }

    this.#ws.onclose = () => {
      this.stopPing()
      this.#loadedConversations.clear()
      if (this.connState !== 'disconnected') {
        this.connState = 'reconnecting'
        this.clearReconnectTimer()
        this.#reconnectTimer = setTimeout(() => {
          if (this.connState === 'reconnecting') {
            this.doConnect()
          }
        }, this.#reconnectDelay)
        this.#reconnectDelay = Math.min(this.#reconnectDelay * 2, 30000)
      }
    }

    this.#ws.onerror = () => {}
  }

  private handleMessage(msg: ServerMsg) {
    switch (msg.type) {
      case 'auth:ok': {
        this.connState = 'connected'
        this.#reconnectDelay = 1000
        this.startPing()
        this.agent = msg.agent
        this.agentLoaded = true
        if (this.#candidatePin) {
          this.pin = this.#candidatePin
          this.#candidatePin = null
        }
        if (this.pin) localStorage.setItem(PIN_KEY, this.pin)
        if (this.#pinResolve) {
          const resolve = this.#pinResolve
          this.#pinResolve = null
          resolve(true)
        }
        const activeIds = new Set(msg.activeStreams.map(s => s.conversationId))
        const pendingIds = new Set(msg.pendingTurns || [])
        for (const snapshot of msg.activeStreams) {
          const state = this.getConvState(snapshot.conversationId)
          state.streamState = 'streaming'
          if (!state.streamStartTime) state.streamStartTime = Date.now()
          state.streamParts = rebuildPartsFromSnapshot(snapshot)
          state.streamSeq = snapshot.seq
        }
        // A queued turn hasn't streamed anything yet, but a reply is coming:
        // show it as streaming-with-no-parts (the typing indicator).
        for (const convId of pendingIds) {
          const state = this.getConvState(convId)
          if (state.streamState !== 'streaming') {
            state.streamState = 'streaming'
            state.streamParts = []
            state.streamSeq = 0
            state.streamStartTime = Date.now()
          }
        }
        // A stream that ended while we were disconnected: clear its stale
        // streaming state (the eager reload below fetches the finished reply).
        for (const [convId, state] of Object.entries(this.convStates)) {
          if (state.streamState === 'streaming' && !activeIds.has(convId) && !pendingIds.has(convId)) {
            state.streamState = 'idle'
            state.streamParts = []
            state.streamSeq = 0
            state.streamStartTime = 0
          }
        }
        if (this.#pendingSend) {
          this.send({
            type: 'chat',
            conversationId: this.#pendingSend.conversationId,
            clientMsgId: this.#pendingSend.clientMsgId,
            content: this.#pendingSend.content,
          })
        }
        if (msg.agent && !this.#loadedConversations.has(msg.agent.conversationId)) {
          this.send({ type: 'conv:load', conversationId: msg.agent.conversationId })
        }
        this.send({ type: 'conv:list' })
        break
      }

      case 'auth:fail': {
        this.connState = 'disconnected'
        localStorage.removeItem(PIN_KEY)
        this.pin = null
        this.#candidatePin = null
        if (this.#pinResolve) {
          const resolve = this.#pinResolve
          this.#pinResolve = null
          resolve(false)
        }
        break
      }

      case 'pong':
        if (this.#pongTimeout) {
          clearTimeout(this.#pongTimeout)
          this.#pongTimeout = null
        }
        break

      case 'conv:messages': {
        const state = this.getConvState(msg.conversationId)
        state.messages = msg.messages
        this.#loadedConversations.add(msg.conversationId)
        if (msg.stream) {
          state.streamState = 'streaming'
          if (!state.streamStartTime) state.streamStartTime = Date.now()
          state.streamParts = rebuildPartsFromSnapshot(msg.stream)
          state.streamSeq = msg.stream.seq
        } else if (msg.pending && state.streamState !== 'streaming') {
          // A reply is queued server-side but hasn't started streaming.
          state.streamState = 'streaming'
          state.streamParts = []
          state.streamSeq = 0
          state.streamStartTime = Date.now()
        }
        break
      }

      case 'conv:list':
        this.conversations = msg.conversations
        break

      case 'conv:created':
        if (!this.conversations.some(c => c.id === msg.conversation.id)) {
          this.conversations = [...this.conversations, msg.conversation]
        }
        if (this.#createResolve) {
          const resolve = this.#createResolve
          this.#createResolve = null
          resolve(msg.conversation.id)
        }
        break

      case 'msg:user': {
        const state = this.getConvState(msg.conversationId)
        // Already known (a reload raced the confirmation, or a resend was
        // re-confirmed) - appending again would duplicate a keyed row.
        if (state.messages.some(m => m.id === msg.messageId)) {
          this.#pendingSend = null
          break
        }
        const confirmed = localMessage(msg.conversationId, 'user', msg.content, { id: msg.messageId })
        const optIdx = state.messages.findIndex(m => m.id < 0 && m.role === 'user')
        if (optIdx >= 0) {
          const messages = [...state.messages]
          messages[optIdx] = confirmed
          state.messages = messages
        } else {
          state.messages = [...state.messages, confirmed]
        }
        this.#pendingSend = null
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
        }
        break
      }

      case 'done': {
        const state = this.getConvState(msg.conversationId)
        // Drop any tool announced but never completed (truncated tail).
        const parts = state.streamParts.filter(p => p.type === 'text' || (p.type === 'tool' && p.result !== undefined))
        const text = parts.filter(p => p.type === 'text').map(p => (p as { content: string }).content).join('')
        if (parts.length > 0) {
          state.messages = [...state.messages, localMessage(msg.conversationId, 'assistant', text, {
            usage_input: msg.usage?.input ?? null,
            usage_output: msg.usage?.output ?? null,
            parts: JSON.stringify(parts), // keep tools where they were used
          })]
        }
        state.streamState = 'idle'
        state.streamParts = []
        state.streamSeq = 0
        state.streamStartTime = 0
        break
      }

      case 'agent:updated':
        this.agent = msg.agent
        this.settingsError = null
        break

      case 'settings:error':
        this.settingsError = msg.message
        break

      case 'doc:added':
        for (const fn of this.#docListeners) {
          try { fn(msg) } catch {}
        }
        break

      case 'doc:error':
        for (const fn of this.#docListeners) {
          try { fn({ conversationId: msg.conversationId, clientDocId: msg.clientDocId, error: msg.message }) } catch {}
        }
        break

      case 'error': {
        const state = this.getConvState(msg.conversationId)
        const parts: StreamPart[] = [...state.streamParts]
        const text = parts.filter(p => p.type === 'text').map(p => (p as { content: string }).content).join('')
        if (parts.length > 0) {
          parts.push({ type: 'text', content: `\n\n*Error: ${msg.message}*` })
          state.messages = [...state.messages, localMessage(
            msg.conversationId, 'assistant', text + `\n\n*Error: ${msg.message}*`,
            { parts: JSON.stringify(parts) },
          )]
        }
        state.streamState = 'idle'
        state.streamParts = []
        state.streamSeq = 0
        state.streamStartTime = 0
        state.error = msg.message
        setTimeout(() => {
          if (state.error === msg.message) state.error = null
        }, 8000)
        break
      }
    }
  }

  sendChat(conversationId: string, content: string) {
    const clientMsgId = crypto.randomUUID()

    const state = this.getConvState(conversationId)
    state.messages = [...state.messages, localMessage(conversationId, 'user', content)]
    state.streamState = 'streaming'
    state.streamParts = []
    state.streamSeq = 0
    state.streamStartTime = Date.now()
    state.error = null

    this.#pendingSend = { conversationId, content, clientMsgId }

    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.send({ type: 'chat', conversationId, clientMsgId, content })
    }
  }

  // Store a long attachment as an out-of-context document. The real id comes back
  // via onDocAdded, keyed by clientDocId.
  addDocument(conversationId: string, clientDocId: string, title: string, content: string) {
    this.send({ type: 'doc:add', conversationId, clientDocId, title, content })
  }

  // Start a side conversation: branches off the main line with a frozen render
  // of it. Resolves with the new conversation id (the server sends conv:created).
  createSideConversation(title: string): Promise<string> {
    return new Promise((resolve) => {
      this.#createResolve = resolve
      this.send({ type: 'conv:create-side', title })
      setTimeout(() => {
        if (this.#createResolve === resolve) {
          this.#createResolve = null
          resolve('')
        }
      }, 10_000)
    })
  }

  loadConversation(id: string) {
    if (this.#loadedConversations.has(id)) return
    this.send({ type: 'conv:load', conversationId: id })
  }

  stopStream(conversationId: string) {
    this.send({ type: 'stop', conversationId })
  }

  private send(msg: ClientMsg) {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(msg))
    }
  }

  private startPing() {
    this.stopPing()
    // Tighter heartbeat: a silent drop surfaces in ~15s worst case instead of ~35s.
    this.#pingInterval = setInterval(() => {
      if (this.#ws?.readyState === WebSocket.OPEN) {
        this.send({ type: 'ping', ts: Date.now() })
        if (!this.#pongTimeout) {
          this.#pongTimeout = setTimeout(() => {
            this.#pongTimeout = null
            this.#ws?.close()
          }, 5_000)
        }
      }
    }, 10_000)
  }

  private stopPing() {
    if (this.#pingInterval) { clearInterval(this.#pingInterval); this.#pingInterval = null }
    if (this.#pongTimeout) { clearTimeout(this.#pongTimeout); this.#pongTimeout = null }
  }

  // The browser knows the network died before any heartbeat can: reflect it instantly.
  private handleOffline() {
    if (this.connState === 'connected' || this.connState === 'connecting' || this.connState === 'authenticating') {
      this.connState = 'reconnecting'
      this.stopPing()
      if (this.#ws) { try { this.#ws.close() } catch {} this.#ws = null }
    }
  }

  private handleOnline() {
    if (this.pin && this.connState !== 'connected' && this.connState !== 'connecting' && this.connState !== 'authenticating') {
      this.clearReconnectTimer()
      this.#reconnectDelay = 1000
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