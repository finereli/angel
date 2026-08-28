-- Per-agent wake-up schedule. One pending wake-up per agent at a time.
CREATE TABLE agent_wakeups (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id),
  wake_at TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
