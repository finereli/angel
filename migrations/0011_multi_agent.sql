-- Transform the system from single-agent to multi-agent with DM conversations.
-- Each agent gets exactly one conversation (a DM), separate memory, shared chatroom.

PRAGMA foreign_keys = OFF;

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

-- 3. Recreate tags: drop inline UNIQUE on name, add per-agent composite unique
CREATE TABLE tags_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  observation_count INTEGER NOT NULL DEFAULT 0,
  agent_id TEXT NOT NULL DEFAULT 'angel',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO tags_new (id, name, description, observation_count, agent_id, created_at, updated_at)
  SELECT id, name, description, observation_count, 'angel', created_at, updated_at FROM tags;
DROP TABLE tags;
ALTER TABLE tags_new RENAME TO tags;
CREATE UNIQUE INDEX idx_tags_agent_name ON tags(agent_id, name);
CREATE INDEX idx_tags_updated ON tags(updated_at DESC);

-- 4. Recreate lists: drop inline UNIQUE on name, add per-agent composite unique
CREATE TABLE lists_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  load_mode TEXT NOT NULL DEFAULT 'on-demand',
  agent_id TEXT NOT NULL DEFAULT 'angel',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO lists_new (id, name, description, load_mode, agent_id, created_at)
  SELECT id, name, description, load_mode, 'angel', created_at FROM lists;
DROP TABLE lists;
ALTER TABLE lists_new RENAME TO lists;
CREATE UNIQUE INDEX idx_lists_agent_name ON lists(agent_id, name);

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

PRAGMA foreign_keys = ON;
