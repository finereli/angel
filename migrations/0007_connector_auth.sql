-- A connector sign-in in flight: the OAuth callback arrives at the worker with
-- only the state, and this says whose Durable Object it belongs to. Rows are
-- deleted when used and swept after a day.
CREATE TABLE IF NOT EXISTS connector_auth (
  state TEXT PRIMARY KEY,
  sub TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
