-- Allow multiple reasons per pinned message (one per person).
-- SQLite can't DROP CONSTRAINT, so recreate the table.
CREATE TABLE wall_pins_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL REFERENCES chatroom_messages(id),
  pinned_by TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(message_id, pinned_by)
);
INSERT INTO wall_pins_new (id, message_id, pinned_by, reason, created_at)
  SELECT id, message_id, pinned_by, reason, created_at FROM wall_pins;
DROP TABLE wall_pins;
ALTER TABLE wall_pins_new RENAME TO wall_pins;
CREATE INDEX idx_wall_created ON wall_pins(created_at);
