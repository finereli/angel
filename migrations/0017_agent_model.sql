-- Per-agent model override. When set, the agent uses this model instead of the
-- global DEEPSEEK_MODEL / default. Allows mixing models across agents.
ALTER TABLE agents ADD COLUMN model TEXT DEFAULT NULL;
