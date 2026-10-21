-- The old single-user tables. Their data now lives in each user's own Durable
-- Object, and the one-time import is gone; Eli cleared the owner's data rather
-- than carry it over.
DROP TABLE IF EXISTS summary_sources;
DROP TABLE IF EXISTS observation_tags;
DROP TABLE IF EXISTS observation_summaries;
DROP TABLE IF EXISTS observations;
DROP TABLE IF EXISTS stream_summaries;
DROP TABLE IF EXISTS embeddings;
DROP TABLE IF EXISTS tags;
DROP TABLE IF EXISTS list_items;
DROP TABLE IF EXISTS lists;
DROP TABLE IF EXISTS documents;
DROP TABLE IF EXISTS agent_wakeups;
DROP TABLE IF EXISTS agent_scripts;
DROP TABLE IF EXISTS agent_logs;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS conversations;
DROP TABLE IF EXISTS agents;
DROP TABLE IF EXISTS system_doc;
DROP TABLE IF EXISTS kv;
