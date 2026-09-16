-- Angel: single-agent companion baseline.
-- One consolidated schema. The agents table is generic - the baseline ships one
-- row, but nothing here assumes a single agent.

-- ---- The agent ----
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  -- Recurring wake-up interval. NULL = manual wake-ups only.
  cadence_minutes INTEGER DEFAULT NULL,
  -- Per-agent model override; NULL falls back to DEEPSEEK_MODEL / the default.
  model TEXT DEFAULT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---- Conversations: the human-side view over the one linear stream ----
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  title TEXT,
  topic TEXT,
  agent_id TEXT REFERENCES agents(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  archived INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'web'
);
CREATE INDEX idx_conversations_agent ON conversations(agent_id);

-- ---- The stream: one linear table. conversation_id is only the view ----
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  tool_calls TEXT,
  tool_call_id TEXT,
  usage_input INTEGER,
  usage_output INTEGER,
  -- JSON StreamPart[]: the interleaved order of text and tool calls in a reply,
  -- so tools render where they were used. UI only; `content` stays flat text.
  parts TEXT
);
CREATE INDEX idx_messages_conv ON messages(conversation_id);
CREATE INDEX idx_messages_role_id ON messages(role, id);

-- ---- Tags: scope per-tag observation summaries ----
CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  observation_count INTEGER NOT NULL DEFAULT 0,
  agent_id TEXT NOT NULL DEFAULT 'angel',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_tags_agent_name ON tags(agent_id, name);
CREATE INDEX idx_tags_updated ON tags(updated_at DESC);

-- ---- Observations: the durable record, written by the agent in his own voice ----
CREATE TABLE observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'agent',
  conversation_id TEXT,
  agent_id TEXT DEFAULT 'angel',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_observations_agent ON observations(agent_id);

CREATE TABLE observation_tags (
  observation_id INTEGER NOT NULL REFERENCES observations(id),
  tag_id TEXT NOT NULL REFERENCES tags(id),
  PRIMARY KEY (observation_id, tag_id)
);
CREATE INDEX idx_obs_tags_tag ON observation_tags(tag_id);

-- ---- Per-tag observation pyramid (greedy batches, provenance-tracked) ----
CREATE TABLE observation_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tag_id TEXT NOT NULL REFERENCES tags(id),
  tier INTEGER NOT NULL,
  text TEXT NOT NULL,
  source_count INTEGER NOT NULL DEFAULT 0,
  start_ts TEXT,
  end_ts TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_obs_sum_tag_tier ON observation_summaries(tag_id, tier);

-- Provenance edges: which observations/summaries fed each summary (exact-once)
CREATE TABLE summary_sources (
  summary_id INTEGER NOT NULL REFERENCES observation_summaries(id),
  source_type TEXT NOT NULL,       -- 'observation' | 'summary'
  source_id INTEGER NOT NULL,
  PRIMARY KEY (summary_id, source_type, source_id)
);

-- ---- Stream pyramid: index-0 anchored, immutable tiles ----
CREATE TABLE stream_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tier INTEGER NOT NULL,
  start_index INTEGER NOT NULL,
  end_index INTEGER NOT NULL,
  start_ts TEXT,
  end_ts TEXT,
  text TEXT NOT NULL,
  source_count INTEGER NOT NULL DEFAULT 0,
  agent_id TEXT DEFAULT 'angel',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_stream_tier_start ON stream_summaries(agent_id, tier, start_index);

-- ---- Embeddings over observations and observation_summaries ----
CREATE TABLE embeddings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type TEXT NOT NULL,       -- 'observation' | 'obs_summary'
  source_id INTEGER NOT NULL,
  vector TEXT NOT NULL,
  agent_id TEXT DEFAULT 'angel',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_type, source_id)
);
CREATE INDEX idx_embeddings_source ON embeddings(source_type, source_id);
CREATE INDEX idx_embeddings_agent ON embeddings(agent_id);

-- ---- Lists: structured, self-managed ----
CREATE TABLE lists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  load_mode TEXT NOT NULL DEFAULT 'on-demand',  -- 'always' | 'on-demand' | 'per-message'
  agent_id TEXT NOT NULL DEFAULT 'angel',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_lists_agent_name ON lists(agent_id, name);

CREATE TABLE list_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id TEXT NOT NULL REFERENCES lists(id),
  content TEXT NOT NULL,
  ordinal INTEGER,
  superseded_by INTEGER REFERENCES list_items(id),
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_list_items_list ON list_items(list_id);

-- ---- Documents held OUT of context, read in passes with read_document ----
CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  line_count INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_documents_conversation ON documents(conversation_id);

-- ---- The agent's understanding of his own system (architecture README) ----
CREATE TABLE system_doc (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT,
  agent_id TEXT NOT NULL DEFAULT 'angel',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_system_doc_agent ON system_doc(agent_id);

-- ---- Wake-up schedule. One pending wake-up per agent at a time ----
CREATE TABLE agent_wakeups (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id),
  wake_at TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---- Saved run_code scripts ----
CREATE TABLE agent_scripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  name TEXT NOT NULL,
  description TEXT,
  code TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(agent_id, name)
);

-- ---- Structured log of stream lifecycle events (written by the DO) ----
CREATE TABLE agent_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT,
  conversation_id TEXT,
  level TEXT NOT NULL,
  event TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_agent_logs_created ON agent_logs(created_at DESC);

-- ---- Key-value store for worker state (flags, checkpoints) ----
CREATE TABLE kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---- Seed: near-empty. No persona. Identity precipitates from the stream. ----
INSERT INTO agents (id, name) VALUES ('angel', 'Angel');

INSERT INTO conversations (id, title, topic, agent_id)
VALUES ('main', 'Angel', NULL, 'angel');

INSERT INTO lists (id, name, description, load_mode, agent_id) VALUES
  ('list-instructions', 'instructions', 'Operating instructions Angel maintains for himself.', 'always', 'angel'),
  ('list-memory', 'memory-instructions', 'How Angel organizes his memory and what is worth remembering.', 'always', 'angel');

INSERT INTO system_doc (content, agent_id) VALUES ('', 'angel');
