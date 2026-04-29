-- Migration 012: Status-Modell-Reduktion + plannedSteps + retryCount (Issue #80)
-- Purpose:
--   1. Reduce SessionStatus to 5 values: recording, queued, processing, review, error
--   2. Add plannedSteps column (JSON array of TaskType, frozen at queued→processing)
--   3. Add retryCount column for 3-stage retry-limit UX
-- Rationale: tasks[] becomes Source-of-Truth for "current step"; SessionStatus only
--   carries lifecycle phase. plannedSteps captures dynamic pipeline (summarization
--   conditional, PDF OCR conditional) at processing-start.

-- Step 1: collapse legacy status values to 'processing'
-- Sessions in transcribing/diarizing/extracting/anonymizing were mid-pipeline;
-- the new model treats them all as 'processing' since tasks[] holds the actual step.
UPDATE sessions
SET status = 'processing'
WHERE status IN ('transcribing', 'diarizing', 'extracting', 'anonymizing');

-- Step 2: introduce 'queued' lifecycle phase
-- Sessions that were 'recording' but have no audio_path yet stay recording.
-- Sessions waiting in queue (have tasks but no running task) become 'queued'.
-- This update is best-effort; in practice the migration runs at app start when
-- no tasks are running, so 'queued' state is transient. The schema however must
-- accept it from now on.
-- (No UPDATE needed; new sessions enter 'queued' via TaskQueueService in Phase C.)

-- Step 3: add plannedSteps column (JSON-encoded array, NULL for legacy rows)
ALTER TABLE sessions ADD COLUMN planned_steps TEXT;

-- Step 4: backfill planned_steps for in-progress sessions using a conservative default
-- (full audio pipeline excl. summarization, full PDF pipeline excl. OCR + summarization).
-- Newly-queued sessions populate this column atomically when entering 'processing'.
UPDATE sessions
SET planned_steps = '["diarization","transcription","alignment","anonymization"]'
WHERE type = 'audio' AND status = 'processing' AND planned_steps IS NULL;

UPDATE sessions
SET planned_steps = '["extraction","anonymization"]'
WHERE type = 'pdf' AND status = 'processing' AND planned_steps IS NULL;

-- Step 5: add retryCount column (defaults to 0 for all rows)
ALTER TABLE sessions ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
