-- Migration 011: Pipeline Inversion (Issue #78)
-- Purpose:
--   1. Drop quality_flag column (replaced by structural fix in ADR-007)
--   2. Flip all in-flight sessions to 'error' so they restart cleanly under new pipeline order
-- Rationale: pipeline order changed; any session not in 'review' or 'error' was started
-- under the old order and would be inconsistent if resumed.

-- Step 1: drop column (requires SQLite >= 3.35.0; better-sqlite3 ^12 ships SQLite 3.46+)
ALTER TABLE sessions DROP COLUMN quality_flag;

-- Step 2: flip in-flight sessions
UPDATE sessions
SET status = 'error',
    error_message = 'Sitzung wurde durch Pipeline-Update unterbrochen — bitte erneut starten.'
WHERE status NOT IN ('review', 'error');

-- Step 3: cancel all pending/running tasks for those sessions so retry recreates them
-- (Table name is task_queue per src/main/db/migrations/001-initial-schema.sql)
UPDATE task_queue
SET status = 'cancelled'
WHERE session_id IN (
  SELECT id FROM sessions WHERE status = 'error'
)
AND status IN ('pending', 'running');
