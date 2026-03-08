-- Add aligned_transcript_path for post-diarization aligned transcript (raw ASR transcript preserved)
-- Add extracted_path for PDF extraction result
ALTER TABLE sessions ADD COLUMN aligned_transcript_path TEXT;
ALTER TABLE sessions ADD COLUMN extracted_path TEXT;
