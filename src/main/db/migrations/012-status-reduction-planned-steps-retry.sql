-- Migration 012: Status-Modell-Reduktion + plannedSteps + retryCount (Issue #80)
-- Purpose:
--   1. Reduce SessionStatus to 5 values: recording, queued, processing, review, error
--   2. Add planned_steps column (JSON array of TaskType, frozen at queued→processing)
--   3. Add retry_count column for 3-stage retry-limit UX
-- Rationale: tasks[] becomes Source-of-Truth for "current step"; SessionStatus only
--   carries lifecycle phase. plannedSteps captures dynamic pipeline (summarization
--   conditional, PDF OCR conditional) at processing-start.
-- SQLite-Pattern: rebuild table to update CHECK constraint (cf. migrations 004/007).

CREATE TABLE sessions_new (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('audio', 'pdf')),
    status TEXT NOT NULL CHECK(status IN (
        'recording', 'queued', 'processing', 'review', 'error'
    )),
    audio_path TEXT,
    transcript_path TEXT,
    anonymized_path TEXT,
    pdf_path TEXT,
    entity_map TEXT,
    error_message TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    diarization_path TEXT,
    review_at TEXT,
    aligned_transcript_path TEXT,
    extracted_path TEXT,
    word_count INTEGER,
    summary TEXT,
    summary_model_id TEXT,
    summarized_at TEXT,
    planned_steps TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0
);

-- Copy all rows, mapping legacy status values to 'processing'.
-- Sessions in transcribing/diarizing/extracting/anonymizing were mid-pipeline;
-- the new model treats them all as 'processing' since tasks[] holds the actual step.
INSERT INTO sessions_new (
    id, title, type, status,
    audio_path, transcript_path, anonymized_path, pdf_path,
    entity_map, error_message, created_at, updated_at,
    diarization_path, review_at,
    aligned_transcript_path, extracted_path, word_count,
    summary, summary_model_id, summarized_at
)
SELECT
    id, title, type,
    CASE
        WHEN status IN ('transcribing', 'diarizing', 'extracting', 'anonymizing') THEN 'processing'
        ELSE status
    END as status,
    audio_path, transcript_path, anonymized_path, pdf_path,
    entity_map, error_message, created_at, updated_at,
    diarization_path, review_at,
    aligned_transcript_path, extracted_path, word_count,
    summary, summary_model_id, summarized_at
FROM sessions;

-- Backfill planned_steps for in-progress sessions using a conservative default
-- (full audio pipeline excl. summarization, full PDF pipeline excl. OCR + summarization).
-- Newly-queued sessions populate this column atomically when entering 'processing'.
UPDATE sessions_new
SET planned_steps = '["diarization","transcription","alignment","anonymization"]'
WHERE type = 'audio' AND status = 'processing';

UPDATE sessions_new
SET planned_steps = '["extraction","anonymization"]'
WHERE type = 'pdf' AND status = 'processing';

-- Swap tables.
DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;

CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at);
