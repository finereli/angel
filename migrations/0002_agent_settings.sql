-- Model override already existed as agents.model (NULL = fall back to
-- DEEPSEEK_MODEL / the code default). This adds the other half of the
-- settings screen: a per-agent reasoning/thinking effort dial.
ALTER TABLE agents ADD COLUMN reasoning_effort TEXT DEFAULT NULL;
