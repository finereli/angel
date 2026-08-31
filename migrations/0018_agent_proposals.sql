-- Agent creation proposals: two existing agents must agree before a new agent is born.
CREATE TABLE IF NOT EXISTS agent_proposals (
  id TEXT PRIMARY KEY,
  proposed_name TEXT NOT NULL,
  proposed_id TEXT NOT NULL,
  system_doc TEXT NOT NULL,
  cadence_minutes INTEGER,
  proposer_id TEXT NOT NULL,
  approver_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending, approved, rejected
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  FOREIGN KEY (proposer_id) REFERENCES agents(id)
);
