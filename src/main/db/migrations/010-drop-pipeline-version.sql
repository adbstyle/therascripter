-- ADR-006 update: drop the retry-on-pipeline-improvement mechanism. The
-- pipeline now always runs to completion and surfaces low-quality runs via
-- a non-blocking warning banner in the review editor.
--
-- No row-level migration is needed: the original sessions.status CHECK
-- constraint in 001-initial-schema.sql never included
-- 'transcription_quality_failed', so PR #66's UPDATEs to that value would
-- have failed at runtime with SQLITE_CONSTRAINT — meaning no real database
-- can carry rows in the deprecated terminal state.
ALTER TABLE sessions DROP COLUMN transcription_pipeline_version;
