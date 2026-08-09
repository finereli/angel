-- infinite-context rewrite: destructive reset to the new schema.
-- We do not keep the old record. Angel wakes up blank.

-- ---- Drop the old design ----
DROP TABLE IF EXISTS glopus_models;
DROP TABLE IF EXISTS short_term;
DROP TABLE IF EXISTS cron_runs;
DROP TABLE IF EXISTS summary_sources;
DROP TABLE IF EXISTS summaries;
DROP TABLE IF EXISTS observation_tags;
DROP TABLE IF EXISTS observations;
DROP TABLE IF EXISTS embeddings;
DROP TABLE IF EXISTS list_items;
DROP TABLE IF EXISTS lists;
DROP TABLE IF EXISTS models;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS conversations;
DROP TABLE IF EXISTS stream_summaries;
DROP TABLE IF EXISTS observation_summaries;
DROP TABLE IF EXISTS system_doc;

-- ---- Conversations: human-side threads over the one linear stream ----
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  title TEXT,
  topic TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  archived INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'web'
);

-- ---- The stream: one global linear table. conversation_id is only the view ----
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  tool_calls TEXT,
  tool_call_id TEXT,
  usage_input INTEGER,
  usage_output INTEGER
);
CREATE INDEX idx_messages_conv ON messages(conversation_id);
CREATE INDEX idx_messages_role_id ON messages(role, id);

-- ---- Tags (was "models"): scope per-tag observation summaries. No portraits ----
CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  observation_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---- Observations: the durable record, written by Angel in his own voice ----
CREATE TABLE observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'agent',
  conversation_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE observation_tags (
  observation_id INTEGER NOT NULL REFERENCES observations(id),
  tag_id TEXT NOT NULL REFERENCES tags(id),
  PRIMARY KEY (observation_id, tag_id)
);
CREATE INDEX idx_obs_tags_tag ON observation_tags(tag_id);

-- ---- Per-tag observation summary pyramid (greedy batches, provenance-tracked) ----
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
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_stream_tier_start ON stream_summaries(tier, start_index);

-- ---- Embeddings over observations and observation_summaries (not stream tiles) ----
CREATE TABLE embeddings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type TEXT NOT NULL,       -- 'observation' | 'obs_summary'
  source_id INTEGER NOT NULL,
  vector TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_type, source_id)
);
CREATE INDEX idx_embeddings_source ON embeddings(source_type, source_id);

-- ---- Lists: structured, self-managed ----
CREATE TABLE lists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  load_mode TEXT NOT NULL DEFAULT 'on-demand',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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

-- ---- Angel's understanding of his own system (architecture README), single row ----
CREATE TABLE system_doc (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  content TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---- Seed: near-empty. No persona, no self/eli portrait, no Glopus. ----
INSERT INTO lists (id, name, description, load_mode) VALUES
  ('list-instructions', 'instructions', 'Operating instructions Angel maintains for himself.', 'always'),
  ('list-memory', 'memory-instructions', 'How Angel organizes his memory and what is worth remembering.', 'always');

INSERT INTO system_doc (id, content) VALUES (1, '');
