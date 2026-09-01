-- Direct messages between Eli and individual agents.
-- Each conversation is keyed by agent_id (Eli ↔ that agent).
CREATE TABLE dm_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  author TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_dm_agent_created ON dm_messages(agent_id, created_at);
