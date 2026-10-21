export interface Env {
  // Shared control plane (users, MCP). A user's own data is in their Durable
  // Object; inside the DO this same name points at that private database.
  DB: D1Database
  AI: Ai
  ASSETS: Fetcher
  ANGEL_DO: DurableObjectNamespace
  // Legacy: signs the MCP OAuth tokens until MCP moves to login.finereli.com.
  PIN: string
  OPENROUTER_API_KEY: string
  OWNER_EMAIL: string
  DEV_AUTH?: string
  // Set inside a user's DO only (see durable-object.ts): who they are and where.
  USER_NAME?: string
  USER_TZ?: string
  USER_SUB?: string
  // The app's public origin, for links that come back to it (OAuth redirects).
  APP_ORIGIN?: string
  // Inside the DO, DB is the user's own database; this is the shared D1.
  CONTROL_DB?: D1Database
}

import type { ConnectorInfo } from './connectors'
export type { ConnectorInfo }

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
  parent_id: string | null // set on a side conversation; null for the main line
  seed: string | null // frozen render of the main line at branch time
  seed_at: string | null
}

// What the client sees of a conversation (main or side).
export interface ConversationInfo {
  id: string
  title: string | null
  parentId: string | null
  createdAt: string
  updatedAt: string
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

export interface AgentInfo {
  id: string
  name: string
  conversationId: string
  model: string | null
  reasoningEffort: string | null
  // How Angel sounds, set by the person in Settings (never by Angel in chat).
  voice: string | null
  // Whether there is any conversation yet, so Settings knows if a model change needs a warning.
  hasHistory: boolean
}

export type ClientMsg =
  | { type: 'auth'; tz?: string }
  | { type: 'ping'; ts: number }
  | { type: 'conv:load'; conversationId: string }
  | { type: 'conv:list' }
  | { type: 'conv:create-side'; title: string }
  | { type: 'conv:rename'; conversationId: string; title: string }
  | { type: 'conv:delete'; conversationId: string }
  | { type: 'chat'; conversationId: string; clientMsgId: string; content: string }
  | { type: 'doc:add'; conversationId: string; clientDocId: string; title: string; content: string }
  | { type: 'stop'; conversationId: string }
  | { type: 'settings:set'; model: string; reasoningEffort: string | null }
  | { type: 'settings:voice'; voice: string | null }
  | { type: 'retry'; conversationId: string }
  | { type: 'account:reset' }
  | { type: 'connectors:list' }
  | { type: 'connector:add'; url: string; name?: string; token?: string }
  | { type: 'connector:remove'; id: string }
  | { type: 'connector:sign-in'; id: string }
  | { type: 'connector:reload'; id: string }

export type ServerMsg =
  | { type: 'auth:ok'; activeStreams: StreamSnapshot[]; agent: AgentInfo | null; pendingTurns: string[] }
  | { type: 'auth:fail' }
  | { type: 'pong'; ts: number }
  | { type: 'conv:list'; conversations: ConversationInfo[] }
  | { type: 'conv:created'; conversation: ConversationInfo }
  | { type: 'conv:updated'; conversation: ConversationInfo }
  | { type: 'conv:deleted'; conversationId: string }
  | { type: 'conv:messages'; conversationId: string; messages: MessageRow[]; stream?: StreamSnapshot; pending?: boolean; error?: string }
  | { type: 'account:reset:done' }
  | { type: 'msg:user'; conversationId: string; clientMsgId: string; messageId: number; content: string }
  | { type: 'text'; conversationId: string; seq: number; content: string }
  | { type: 'tool_start'; conversationId: string; seq: number; id: string; name: string; label: string }
  | { type: 'tool_result'; conversationId: string; seq: number; id: string; result: string; label: string }
  | { type: 'done'; conversationId: string; seq: number; usage?: { input: number; output: number } }
  | { type: 'error'; conversationId: string; seq: number; message: string }
  | { type: 'stream:reset'; conversationId: string; seq: number; parts: StreamPart[] }
  | { type: 'doc:added'; conversationId: string; clientDocId: string; id: string; title: string; lineCount: number }
  | { type: 'doc:error'; conversationId: string; clientDocId: string; message: string }
  | { type: 'agent:updated'; agent: AgentInfo }
  | { type: 'settings:error'; message: string }
  | { type: 'connectors'; connectors: ConnectorInfo[] }
  | { type: 'connector:sign-in'; id: string; url: string }
  | { type: 'connector:error'; id?: string; message: string }

// Agent event types (internal, yielded by the agent loop)
export type AgentEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_start'; id: string; name: string; label: string }
  | { type: 'tool_result'; id: string; result: string; label: string }
  | { type: 'reset' } // a truncated attempt is being discarded; clear the current round's partial
  | { type: 'commit' } // the current round's text is final (a tool round follows)
  | { type: 'done'; usage?: { input: number; output: number }; finishReason?: string | null }
  | { type: 'error'; message: string }
