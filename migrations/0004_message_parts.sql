-- Preserve the interleaved order of text and tool calls in an assistant reply,
-- so tools render where they were used (not lumped at the bottom) after the
-- stream finishes and on reload. UI-only; `content` stays flat text for memory.
ALTER TABLE messages ADD COLUMN parts TEXT;
