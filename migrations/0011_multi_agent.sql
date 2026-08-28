-- Transform the system from single-agent to multi-agent with DM conversations.
-- Each agent gets exactly one conversation (a DM), separate memory, shared chatroom.
-- D1 enforces FK constraints and ignores PRAGMA foreign_keys, so we drop child
-- tables before parents, back up data, recreate with new schema, restore.

-- 0. Safety snapshots: permanent copies of every table we'll recreate.
--    These survive the migration. Drop manually once verified:
--    DROP TABLE _pre_multi_tags; DROP TABLE _pre_multi_observation_tags;
--    DROP TABLE _pre_multi_observation_summaries; DROP TABLE _pre_multi_summary_sources;
--    DROP TABLE _pre_multi_lists; DROP TABLE _pre_multi_list_items;
--    DROP TABLE _pre_multi_system_doc; DROP TABLE _pre_multi_conversations;
CREATE TABLE _pre_multi_conversations AS SELECT * FROM conversations;
CREATE TABLE _pre_multi_tags AS SELECT * FROM tags;
CREATE TABLE _pre_multi_observation_tags AS SELECT * FROM observation_tags;
CREATE TABLE _pre_multi_observation_summaries AS SELECT * FROM observation_summaries;
CREATE TABLE _pre_multi_summary_sources AS SELECT * FROM summary_sources;
CREATE TABLE _pre_multi_lists AS SELECT * FROM lists;
CREATE TABLE _pre_multi_list_items AS SELECT * FROM list_items;
CREATE TABLE _pre_multi_system_doc AS SELECT * FROM system_doc;

-- 1. Agents table
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO agents (id, name) VALUES ('angel', 'Angel');
INSERT INTO agents (id, name) VALUES ('nigel', 'Nigel');

-- 2. Conversations: add agent_id, merge existing into Angel's DM
ALTER TABLE conversations ADD COLUMN agent_id TEXT;

INSERT INTO conversations (id, title, topic, agent_id)
VALUES ('dm-angel', 'Angel', NULL, 'angel');

UPDATE messages SET conversation_id = 'dm-angel';
UPDATE documents SET conversation_id = 'dm-angel';

DELETE FROM conversations WHERE agent_id IS NULL;

INSERT INTO conversations (id, title, topic, agent_id)
VALUES ('dm-nigel', 'Nigel', NULL, 'nigel');

-- 3. Recreate tags with agent_id (has FK children: observation_tags, observation_summaries, summary_sources)
--    Back up all data, drop in reverse dependency order, recreate, restore.
CREATE TABLE tags_bak AS SELECT * FROM tags;
CREATE TABLE observation_tags_bak AS SELECT * FROM observation_tags;
CREATE TABLE observation_summaries_bak AS SELECT * FROM observation_summaries;
CREATE TABLE summary_sources_bak AS SELECT * FROM summary_sources;

DROP TABLE summary_sources;
DROP TABLE observation_tags;
DROP TABLE observation_summaries;
DROP TABLE tags;

CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  observation_count INTEGER NOT NULL DEFAULT 0,
  agent_id TEXT NOT NULL DEFAULT 'angel',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO tags (id, name, description, observation_count, agent_id, created_at, updated_at)
  SELECT id, name, description, observation_count, 'angel', created_at, updated_at FROM tags_bak;
CREATE UNIQUE INDEX idx_tags_agent_name ON tags(agent_id, name);
CREATE INDEX idx_tags_updated ON tags(updated_at DESC);

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
INSERT INTO observation_summaries (id, tag_id, tier, text, source_count, start_ts, end_ts, created_at)
  SELECT id, tag_id, tier, text, source_count, start_ts, end_ts, created_at FROM observation_summaries_bak;
CREATE INDEX idx_obs_sum_tag_tier ON observation_summaries(tag_id, tier);

CREATE TABLE observation_tags (
  observation_id INTEGER NOT NULL REFERENCES observations(id),
  tag_id TEXT NOT NULL REFERENCES tags(id),
  PRIMARY KEY (observation_id, tag_id)
);
INSERT INTO observation_tags SELECT * FROM observation_tags_bak;
CREATE INDEX idx_obs_tags_tag ON observation_tags(tag_id);

CREATE TABLE summary_sources (
  summary_id INTEGER NOT NULL REFERENCES observation_summaries(id),
  source_type TEXT NOT NULL,
  source_id INTEGER NOT NULL,
  PRIMARY KEY (summary_id, source_type, source_id)
);
INSERT INTO summary_sources SELECT * FROM summary_sources_bak;

DROP TABLE summary_sources_bak;
DROP TABLE observation_tags_bak;
DROP TABLE observation_summaries_bak;
DROP TABLE tags_bak;

-- 4. Recreate lists with agent_id (has FK child: list_items)
CREATE TABLE lists_bak AS SELECT * FROM lists;
CREATE TABLE list_items_bak AS SELECT * FROM list_items;

DROP TABLE list_items;
DROP TABLE lists;

CREATE TABLE lists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  load_mode TEXT NOT NULL DEFAULT 'on-demand',
  agent_id TEXT NOT NULL DEFAULT 'angel',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO lists (id, name, description, load_mode, agent_id, created_at)
  SELECT id, name, description, load_mode, 'angel', created_at FROM lists_bak;
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
INSERT INTO list_items (id, list_id, content, ordinal, superseded_by, archived, created_at)
  SELECT id, list_id, content, ordinal, superseded_by, archived, created_at FROM list_items_bak;
CREATE INDEX idx_list_items_list ON list_items(list_id);

DROP TABLE list_items_bak;
DROP TABLE lists_bak;

-- Seed Nigel's always-loaded lists (empty, he'll grow them)
INSERT INTO lists (id, name, description, load_mode, agent_id)
VALUES (lower(hex(randomblob(16))), 'instructions', 'How you operate - add rules as you learn them', 'always', 'nigel');
INSERT INTO lists (id, name, description, load_mode, agent_id)
VALUES (lower(hex(randomblob(16))), 'memory-instructions', 'How you organize memory and what is worth keeping', 'always', 'nigel');

-- 5. Add agent_id to observations, stream_summaries, embeddings
ALTER TABLE observations ADD COLUMN agent_id TEXT DEFAULT 'angel';
UPDATE observations SET agent_id = 'angel';

ALTER TABLE stream_summaries ADD COLUMN agent_id TEXT DEFAULT 'angel';
UPDATE stream_summaries SET agent_id = 'angel';

ALTER TABLE embeddings ADD COLUMN agent_id TEXT DEFAULT 'angel';
UPDATE embeddings SET agent_id = 'angel';

-- 6. Fix stream_summaries unique index to include agent_id
DROP INDEX IF EXISTS idx_stream_tier_start;
CREATE UNIQUE INDEX idx_stream_tier_start ON stream_summaries(agent_id, tier, start_index);

-- 7. Recreate system_doc: drop CHECK(id=1) constraint, add agent_id
CREATE TABLE system_doc_new (
  id INTEGER PRIMARY KEY,
  content TEXT,
  agent_id TEXT NOT NULL DEFAULT 'angel',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO system_doc_new (id, content, agent_id, updated_at)
  SELECT id, content, 'angel', updated_at FROM system_doc;
DROP TABLE system_doc;
ALTER TABLE system_doc_new RENAME TO system_doc;
CREATE UNIQUE INDEX idx_system_doc_agent ON system_doc(agent_id);

-- 8. Indexes
CREATE INDEX idx_conversations_agent ON conversations(agent_id);
CREATE INDEX idx_observations_agent ON observations(agent_id);
CREATE INDEX idx_embeddings_agent ON embeddings(agent_id);
