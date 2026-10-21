-- D1 is now the shared control plane. Everything a user owns (messages, memory,
-- lists...) lives in that user's own Durable Object; this table is how the cron
-- finds every DO to poke, and how MCP finds the owner's. Tables 0001-0003
-- created are the old single-user data: kept, read once by the owner's DO when
-- it imports them (see legacy-import.ts), and dropped in a later migration.
CREATE TABLE users (
  sub TEXT PRIMARY KEY,           -- Google account id, from login.finereli.com
  email TEXT NOT NULL,
  name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_users_email ON users(email);
