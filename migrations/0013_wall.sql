-- The Wall: curated pinned messages from the chatroom.
-- Each pin points back to a chatroom message, records who pinned it and why.
CREATE TABLE wall_pins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL REFERENCES chatroom_messages(id),
  pinned_by TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(message_id)
);
CREATE INDEX idx_wall_created ON wall_pins(created_at);
