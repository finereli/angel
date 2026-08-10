-- Main thread + tangents. Everything is still one linear stream; this only
-- changes how the human view is shaped over it.
--   kind='main'    the one home thread: unlabeled, never folds, opens by default
--   kind='tangent' a side thread, listed under Main, foldable
-- continuous marks HOW a tangent was born (the one bit the linear stream erases):
--   0 = fresh   (opened from the + - an idea that came on its own)
--   1 = continuous (branched from the composer - it arose mid-chat)
-- The agent uses it only to frame the tangent's very first turn.

ALTER TABLE conversations ADD COLUMN kind TEXT NOT NULL DEFAULT 'tangent';
ALTER TABLE conversations ADD COLUMN continuous INTEGER NOT NULL DEFAULT 0;

-- The single main thread, seeded once with a fixed id.
INSERT INTO conversations (id, kind, title, topic) VALUES ('main', 'main', NULL, NULL);
