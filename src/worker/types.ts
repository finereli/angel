import type { Sandbox } from '@cloudflare/sandbox'

export interface Env {
  DB: D1Database
  AI: Ai
  ASSETS: Fetcher
  ANGEL_DO: DurableObjectNamespace
  Sandbox: DurableObjectNamespace<Sandbox>
  PIN: string
  OPENROUTER_API_KEY: string
  DEEPSEEK_MODEL?: string
  RESEND_API_KEY?: string
  X402_WALLET_ADDRESS?: string
  CDP_API_KEY_ID?: string
  CDP_API_KEY_SECRET?: string
  CDP_WALLET_SECRET?: string
  GITHUB_PAT?: string
}

// DB row types

export interface AgentRow {
  id: string
  name: string
  created_at: string
}

export interface ConversationRow {
  id: string
  title: string | null
  topic: string | null
  created_at: string
  updated_at: string
  archived: number
  source: string
  agent_id: string | null
}

export interface MessageRow {
  id: number
  conversation_id: string
  role: string
  content: string
  created_at: string
  tool_calls: string | null
  tool_call_id: string | null
  usage_input: number | null
  usage_output: number | null
  parts: string | null // JSON StreamPart[] for interleaved rendering (UI only)
}

// Interleaved render parts of an assistant reply (text and tools, in order).
export type StreamPart =
  | { type: 'text'; content: string }
  | { type: 'tool'; id: string; name: string; label: string; result?: string }

export interface TagRow {
  id: string
  name: string
  description: string | null
  observation_count: number
  created_at: string
  updated_at: string
}

export interface ObservationRow {
  id: number
  content: string
  source: string
  conversation_id: string | null
  created_at: string
}

export interface ObservationSummaryRow {
  id: number
  tag_id: string
  tier: number
  text: string
  source_count: number
  start_ts: string | null
  end_ts: string | null
  created_at: string
}

export interface StreamSummaryRow {
  id: number
  tier: number
  start_index: number
  end_index: number
  start_ts: string | null
  end_ts: string | null
  text: string
  source_count: number
  created_at: string
}

export interface EmbeddingRow {
  id: number
  source_type: string
  source_id: number
  vector: string
  created_at: string
}

export interface ListRow {
  id: string
  name: string
  description: string | null
  load_mode: string
  created_at: string
}

export interface ListItemRow {
  id: number
  list_id: string
  content: string
  ordinal: number | null
  superseded_by: number | null
  archived: number
  created_at: string
}

// OpenRouter / DeepSeek types

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface StreamChunk {
  id: string
  choices: Array<{
    delta: {
      role?: string
      content?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason: string | null
  }>
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

// WebSocket protocol

export interface StreamSnapshot {
  conversationId: string
  seq: number
  text: string
  tools: Array<{ id: string; name: string; label: string; result?: string }>
  parts: StreamPart[] // ordered text/tool parts for interleaved reconnect rendering
}

export interface ChatroomMessageRow {
  id: number
  author: string
  content: string
  created_at: string
}

export interface WallPinRow {
  id: number
  message_id: number
  pinned_by: string
  reason: string
  created_at: string
  // joined from chatroom_messages
  author: string
  content: string
  message_created_at: string
}

export interface DmMessageRow {
  id: number
  agent_id: string
  author: string
  content: string
  created_at: string
}

export interface AgentInfo {
  id: string
  name: string
  conversationId: string
}

export type ClientMsg =
  | { type: 'auth'; pin: string }
  | { type: 'ping'; ts: number }
  | { type: 'conv:load'; conversationId: string }
  | { type: 'chat'; conversationId: string; clientMsgId: string; content: string }
  | { type: 'doc:add'; conversationId: string; clientDocId: string; title: string; content: string }
  | { type: 'stop'; conversationId: string }
  | { type: 'room:load'; since?: string }
  | { type: 'room:post'; content: string }
  | { type: 'wall:load' }
  | { type: 'wall:pin'; messageId: number; reason?: string }
  | { type: 'wall:unpin'; messageId: number }
  | { type: 'dm:load'; agentId: string; since?: string }
  | { type: 'dm:post'; agentId: string; content: string }

export type ServerMsg =
  | { type: 'auth:ok'; activeStreams: StreamSnapshot[]; agents: AgentInfo[] }
  | { type: 'auth:fail' }
  | { type: 'pong'; ts: number }
  | { type: 'conv:messages'; conversationId: string; messages: MessageRow[]; stream?: StreamSnapshot }
  | { type: 'msg:user'; conversationId: string; clientMsgId: string; messageId: number; content: string }
  | { type: 'text'; conversationId: string; seq: number; content: string }
  | { type: 'tool_start'; conversationId: string; seq: number; id: string; name: string; label: string }
  | { type: 'tool_result'; conversationId: string; seq: number; id: string; result: string; label: string }
  | { type: 'done'; conversationId: string; seq: number; usage?: { input: number; output: number } }
  | { type: 'error'; conversationId: string; seq: number; message: string }
  | { type: 'stream:reset'; conversationId: string; seq: number; parts: StreamPart[] }
  | { type: 'doc:added'; conversationId: string; clientDocId: string; id: string; title: string; lineCount: number }
  | { type: 'doc:error'; conversationId: string; clientDocId: string; message: string }
  | { type: 'room:messages'; messages: ChatroomMessageRow[] }
  | { type: 'room:new'; message: ChatroomMessageRow }
  | { type: 'wall:pins'; pins: WallPinRow[] }
  | { type: 'wall:pinned'; pin: WallPinRow }
  | { type: 'wall:unpinned'; messageId: number }
  | { type: 'dm:messages'; agentId: string; messages: DmMessageRow[] }
  | { type: 'dm:new'; agentId: string; message: DmMessageRow }

// Agent event types (internal, yielded by the agent loop)
export type AgentEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_start'; id: string; name: string; label: string }
  | { type: 'tool_result'; id: string; result: string; label: string }
  | { type: 'reset' } // a truncated attempt is being discarded; clear the current round's partial
  | { type: 'commit' } // the current round's text is final (a tool round follows)
  | { type: 'done'; usage?: { input: number; output: number }; finishReason?: string | null }
  | { type: 'error'; message: string }
