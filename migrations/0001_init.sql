-- Conversations
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  archived INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'web'
);

-- Messages
CREATE TABLE IF NOT EXISTS messages (
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
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);

-- Memory models (pyramid clusters)
CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  portrait TEXT,
  observation_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Observations
CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'agent',
  conversation_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Observation-to-model tags (many-to-many)
CREATE TABLE IF NOT EXISTS observation_tags (
  observation_id INTEGER NOT NULL REFERENCES observations(id),
  model_id TEXT NOT NULL REFERENCES models(id),
  PRIMARY KEY (observation_id, model_id)
);
CREATE INDEX IF NOT EXISTS idx_obs_tags_model ON observation_tags(model_id);

-- Summaries (tiered compression)
CREATE TABLE IF NOT EXISTS summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id TEXT NOT NULL REFERENCES models(id),
  tier INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_summaries_model_tier ON summaries(model_id, tier);

-- Summary sources (which observations/summaries fed into this summary)
CREATE TABLE IF NOT EXISTS summary_sources (
  summary_id INTEGER NOT NULL REFERENCES summaries(id),
  source_type TEXT NOT NULL,
  source_id INTEGER NOT NULL,
  PRIMARY KEY (summary_id, source_type, source_id)
);

-- Embeddings stored as JSON float arrays
CREATE TABLE IF NOT EXISTS embeddings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type TEXT NOT NULL,
  source_id INTEGER NOT NULL,
  vector TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_type, source_id)
);
CREATE INDEX IF NOT EXISTS idx_embeddings_source ON embeddings(source_type, source_id);

-- Lists
CREATE TABLE IF NOT EXISTS lists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  load_mode TEXT NOT NULL DEFAULT 'on-demand',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- List items (with supersede chain)
CREATE TABLE IF NOT EXISTS list_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id TEXT NOT NULL REFERENCES lists(id),
  content TEXT NOT NULL,
  ordinal INTEGER,
  superseded_by INTEGER REFERENCES list_items(id),
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_list_items_list ON list_items(list_id);

-- Short-term pyramid (cross-conversation continuity)
CREATE TABLE IF NOT EXISTS short_term (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tier INTEGER NOT NULL,
  content TEXT NOT NULL,
  pair_start INTEGER NOT NULL,
  pair_end INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_short_term_tier ON short_term(tier);

-- Cron runs (for tracking reflection/consolidation)
CREATE TABLE IF NOT EXISTS cron_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  notes TEXT
);

-- Glopus reference models (imported snapshots)
CREATE TABLE IF NOT EXISTS glopus_models (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  portrait TEXT,
  observation_count INTEGER NOT NULL DEFAULT 0,
  imported_at TEXT NOT NULL DEFAULT (datetime('now'))
);
