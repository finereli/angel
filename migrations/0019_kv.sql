-- Simple key-value store for worker state (health checks, flags, etc.)
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
