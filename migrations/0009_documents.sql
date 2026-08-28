-- Documents held OUT of context for slow reading. The text lives here, not in
-- the message stream; Angel only ever sees the slice he pulls with read_document.
CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  line_count INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_documents_conversation ON documents(conversation_id);
