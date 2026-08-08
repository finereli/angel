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
}

type Listener = () => void

class AngelClient {
  private ws: WebSocket | null = null
  private pin: string = ''
  private connState: ConnState = 'disconnected'
  private conversations: ConversationRow[] = []
  private convStates = new Map<string, ConversationState>()
  private listeners = new Set<Listener>()
  private reconnectDelay = 1000
  private pingInterval: ReturnType<typeof setInterval> | null = null
  private pongTimeout: ReturnType<typeof setTimeout> | null = null
  private pendingSends = new Map<string, { conversationId: string; content: string }>()

  getConnState(): ConnState { return this.connState }
  getConversations(): ConversationRow[] { return this.conversations }

  getConvState(id: string): ConversationState {
    if (!this.convStates.has(id)) {
      this.convStates.set(id, {
        messages: [],
        streamState: 'idle',
        streamParts: [],
        streamSeq: 0,
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
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect')
      this.ws = null
    }
    this.notify()
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
        setTimeout(() => {
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
      case 'auth:ok':
        this.connState = 'connected'
        this.reconnectDelay = 1000
        this.startPing()
        for (const snapshot of msg.activeStreams) {
          const state = this.getConvState(snapshot.conversationId)
          state.streamState = 'streaming'
          state.streamParts = rebuildPartsFromSnapshot(snapshot)
          state.streamSeq = snapshot.seq
        }
        this.send({ type: 'conv:list' })
        this.notify()
        break

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
        this.notify()
        break

      case 'conv:created':
        this.conversations = [{
          id: msg.conversationId,
          title: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          archived: 0,
          source: 'web',
        }, ...this.conversations]
        this.notify()
        break

      case 'conv:archived':
        this.conversations = this.conversations.filter(c => c.id !== msg.conversationId)
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
        }
        // Replace optimistic message (id === -1) if present, otherwise append
        const optIdx = state.messages.findIndex(m => m.id === -1 && m.role === 'user')
        if (optIdx >= 0) {
          state.messages = [...state.messages]
          state.messages[optIdx] = confirmed
        } else {
          state.messages = [...state.messages, confirmed]
        }
        this.pendingSends.delete(msg.clientMsgId)
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
        const text = state.streamParts
          .filter(p => p.type === 'text')
          .map(p => (p as { content: string }).content)
          .join('')
        const tools = state.streamParts
          .filter(p => p.type === 'tool')
        if (text || tools.length > 0) {
          state.messages = [...state.messages, {
            id: 0,
            conversation_id: msg.conversationId,
            role: 'assistant',
            content: text,
            created_at: new Date().toISOString(),
            tool_calls: tools.length > 0 ? JSON.stringify(tools) : null,
            tool_call_id: null,
            usage_input: msg.usage?.input ?? null,
            usage_output: msg.usage?.output ?? null,
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
        const text = state.streamParts
          .filter(p => p.type === 'text')
          .map(p => (p as { content: string }).content)
          .join('')
        if (text) {
          state.messages = [...state.messages, {
            id: 0,
            conversation_id: msg.conversationId,
            role: 'assistant',
            content: text + `\n\n*Error: ${msg.message}*`,
            created_at: new Date().toISOString(),
            tool_calls: null,
            tool_call_id: null,
            usage_input: null,
            usage_output: null,
          }]
        }
        state.streamState = 'idle'
        state.streamParts = []
        state.streamSeq = 0
        this.notify()
        break
      }
    }
  }

  sendChat(conversationId: string, content: string) {
    const clientMsgId = crypto.randomUUID()
    this.pendingSends.set(clientMsgId, { conversationId, content })

    const state = this.getConvState(conversationId)
    state.messages = [...state.messages, {
      id: -1,
      conversation_id: conversationId,
      role: 'user',
      content,
      created_at: new Date().toISOString(),
      tool_calls: null,
      tool_call_id: null,
      usage_input: null,
      usage_output: null,
    }]
    state.streamState = 'streaming'
    state.streamParts = []
    state.streamSeq = 0
    this.notify()

    this.send({ type: 'chat', conversationId, clientMsgId, content })
  }

  createConversation() {
    this.send({ type: 'conv:create' })
  }

  archiveConversation(id: string) {
    this.send({ type: 'conv:archive', conversationId: id })
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
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.send({ type: 'ping', ts: Date.now() })
        this.pongTimeout = setTimeout(() => {
          this.ws?.close()
        }, 10_000)
      }
    }, 25_000)
  }

  private stopPing() {
    if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null }
    if (this.pongTimeout) { clearTimeout(this.pongTimeout); this.pongTimeout = null }
  }
}

function rebuildPartsFromSnapshot(snapshot: StreamSnapshot): StreamPart[] {
  const parts: StreamPart[] = []
  if (snapshot.text) {
    parts.push({ type: 'text', content: snapshot.text })
  }
  for (const tool of snapshot.tools) {
    parts.push({ type: 'tool', id: tool.id, name: tool.name, label: tool.label, result: tool.result })
  }
  return parts
}

export const angel = new AngelClient()
