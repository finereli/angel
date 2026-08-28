-- Shared chatroom for cross-agent communication. Pull-based: each agent
-- reads since its last-seen timestamp when it's active.
CREATE TABLE chatroom_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_chatroom_created ON chatroom_messages(created_at);
