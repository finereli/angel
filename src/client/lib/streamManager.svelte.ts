import { login } from './login'
import type { LoginUser } from '$shared/lib/finereli-login'
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
// directly and re-render; there is no subscribe() layer. The credential is the
// login.finereli.com token: offered on every connect (as a WebSocket
// subprotocol, since browsers can't set headers), dropped when the server says
// it's dead.
class AngelClient {
  user = $state<LoginUser | null>(null)
  // Signed in with Google but not on the allow-list: the email, to say so.
  denied = $state<string | null>(null)
  // Local dev only: the worker's DEV_AUTH bypass answered /api/me, no token needed.
  devSession = $state(false)
  connState = $state<ConnState>('disconnected')
  agent = $state<AgentInfo | null>(null)
  agentLoaded = $state(false)
  settingsError = $state<string | null>(null)
  convStates = $state<Record<string, ConversationState>>({})
  conversations = $state<ConversationInfo[]>([])
  // False until the server has answered conv:list, so the UI can tell "none yet" from "not loaded".
  conversationsLoaded = $state(false)

  #ws: WebSocket | null = null
  #docListeners = new Set<DocListener>()
  #reconnectDelay = 1000
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null
  #pingInterval: ReturnType<typeof setInterval> | null = null
  #pongTimeout: ReturnType<typeof setTimeout> | null = null
  #pendingSend: { conversationId: string; content: string; clientMsgId: string } | null = null
  #loadedConversations = new Set<string>()
  #opened = false // the socket got past the upgrade (the worker accepted the token)
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

  get signedIn(): boolean { return this.user !== null || this.devSession }

  get mainConversationId(): string | null { return this.agent?.conversationId ?? null }

  // Optimistic boot: a stored token shows the app immediately; a 401 on the
  // first connect drops back to the sign-in screen.
  async boot() {
    login.onChange((u) => {
      this.user = u
      if (u) { this.denied = null; this.doConnect() } else this.reset()
    })
    await login.handleRedirect()
    this.user = login.user
    if (login.token) this.doConnect()
    else if (location.hostname === 'localhost') {
      const res = await fetch('/api/me').catch(() => null)
      if (res?.ok) { this.devSession = true; this.doConnect() }
    }
  }

  signIn() { return login.signIn() }

  signOut() {
    if (this.devSession) { this.devSession = false; this.reset() } else login.signOut()
  }

  // Everything held belongs to whoever was signed in; drop it all.
  private reset() {
    this.disconnect()
    this.agent = null
    this.agentLoaded = false
    this.convStates = {}
    this.conversations = []
    this.conversationsLoaded = false
    this.denied = null
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

  // Run the last message again after a failed reply.
  retry(conversationId: string) {
    const state = this.getConvState(conversationId)
    state.error = null
    state.streamState = 'streaming'
    state.streamParts = []
    state.streamSeq = 0
    state.streamStartTime = Date.now()
    this.send({ type: 'retry', conversationId })
  }

  dismissError(conversationId: string) {
    this.getConvState(conversationId).error = null
  }

  // Erase everything this account owns on the server and start fresh.
  resetAccount() {
    this.send({ type: 'account:reset' })
  }

  // Set (or clear, with null) how Angel sounds. Lives in Settings on purpose.
  setVoice(voice: string | null) {
    this.send({ type: 'settings:voice', voice })
  }

  updateSettings(model: string, reasoningEffort: string | null) {
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
    const token = login.token
    this.#opened = false
    this.#ws = new WebSocket(`${proto}//${location.host}/ws`, token ? ['angel.v1', `auth.${token}`] : undefined)

    this.#ws.onopen = () => {
      this.#opened = true
      this.connState = 'authenticating'
      this.send({ type: 'auth', tz: Intl.DateTimeFormat().resolvedOptions().timeZone })
    }

    this.#ws.onmessage = (event) => {
      let msg: ServerMsg
      try { msg = JSON.parse(event.data) } catch { return }
      this.handleMessage(msg)
    }

    this.#ws.onclose = () => {
      this.stopPing()
      this.#loadedConversations.clear()
      // Refused at the upgrade: find out whether the sign-in is dead or just the network.
      if (!this.#opened) void this.probe()
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

  // A socket that never opened: 401 means the token is dead (sign in again),
  // 403 that this account isn't allowed in. Anything else is the network, and
  // the reconnect loop carries on.
  private async probe() {
    const token = login.token
    const res = await fetch('/api/me', { headers: token ? { Authorization: `Bearer ${token}` } : {} }).catch(() => null)
    if (res?.status === 401) {
      this.devSession = false
      login.handleUnauthorized()
      if (!login.user) this.reset()
    } else if (res?.status === 403) {
      const body = await res.json().catch(() => ({})) as { email?: string }
      this.disconnect()
      this.denied = body.email ?? ''
    }
  }

  private handleMessage(msg: ServerMsg) {
    switch (msg.type) {
      case 'auth:ok': {
        this.connState = 'connected'
        this.#reconnectDelay = 1000
        this.startPing()
        this.agent = msg.agent
        this.agentLoaded = true
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
        login.handleUnauthorized()
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
        state.error = msg.error ?? null
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
        this.conversationsLoaded = true
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

      case 'conv:updated':
        this.conversations = this.conversations.map(c => (c.id === msg.conversation.id ? msg.conversation : c))
        break

      case 'conv:deleted':
        this.conversations = this.conversations.filter(c => c.id !== msg.conversationId)
        delete this.convStates[msg.conversationId]
        this.#loadedConversations.delete(msg.conversationId)
        // Standing in a chat that just went away: back to the main line.
        if (location.hash === `#/side/${msg.conversationId}`) location.hash = '/chat'
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

      case 'agent:renamed':
        if (this.agent) this.agent = { ...this.agent, name: msg.name }
        break
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

      case 'account:reset:done':
        location.reload()
        break

      case 'error': {
        // The server kept whatever text the reply got out; the error itself is
        // not part of the conversation. It stays up until the next send or retry.
        const state = this.getConvState(msg.conversationId)
        const text = state.streamParts.filter(p => p.type === 'text').map(p => (p as { content: string }).content).join('')
        if (text.trim()) {
          state.messages = [...state.messages, localMessage(
            msg.conversationId, 'assistant', text, { parts: JSON.stringify(state.streamParts) },
          )]
        }
        state.streamState = 'idle'
        state.streamParts = []
        state.streamSeq = 0
        state.streamStartTime = 0
        state.error = msg.message
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

  renameConversation(id: string, title: string) {
    this.send({ type: 'conv:rename', conversationId: id, title })
  }

  deleteConversation(id: string) {
    this.send({ type: 'conv:delete', conversationId: id })
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
    if (this.signedIn && !this.denied && this.connState !== 'connected' && this.connState !== 'connecting' && this.connState !== 'authenticating') {
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