-- Side conversations: an ephemeral branch off the main line. A side chat is a
-- normal conversation row with parent_id set to the main conversation. At
-- creation we render the main line's context once and freeze it in `seed`, so
-- the side chat starts from where the main line stood and never drifts as the
-- main line moves on. Side chats never build the stream pyramid (its tiles are
-- per-agent, not per-conversation), and their transcript is disposable - what
-- survives is whatever the memory pass records as observations.
ALTER TABLE conversations ADD COLUMN parent_id TEXT;
ALTER TABLE conversations ADD COLUMN seed TEXT;
ALTER TABLE conversations ADD COLUMN seed_at TEXT;

CREATE INDEX idx_conversations_parent ON conversations(parent_id);
