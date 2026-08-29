-- Persistent cadence (recurring wake-up interval) per agent.
-- When set, the alarm handler auto-schedules the next wakeup after each firing.
ALTER TABLE agents ADD COLUMN cadence_minutes INTEGER DEFAULT NULL;
