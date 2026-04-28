-- ADR-006 update: drop the retry-on-pipeline-improvement mechanism. The
-- pipeline now always runs to completion and surfaces low-quality runs via
-- a non-blocking warning banner in the review editor.

-- Any session previously stuck in the (now-removed) terminal status is
-- migrated to 'error' so the user can re-trigger the full pipeline via the
-- regular retry button.
UPDATE sessions
SET status = 'error',
    error_message = COALESCE(
      error_message,
      'Transkription wurde wegen Qualitätsproblemen abgebrochen. Bitte erneut versuchen.'
    )
WHERE status = 'transcription_quality_failed';

ALTER TABLE sessions DROP COLUMN transcription_pipeline_version;
