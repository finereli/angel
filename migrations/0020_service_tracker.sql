-- CRM for x402 services: track services, builders, outreach status
CREATE TABLE IF NOT EXISTS x402_services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  name TEXT,
  description TEXT,
  price TEXT,
  network TEXT,
  tags TEXT,
  calls_30d INTEGER,
  payers_30d INTEGER,
  builder TEXT,
  status TEXT DEFAULT 'discovered',
  notes TEXT,
  discovered_by TEXT,
  created_at DATETIME DEFAULT (datetime('now')),
  updated_at DATETIME DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_x402_services_url ON x402_services(url);
