ALTER TABLE sessions ADD COLUMN review_at TEXT;
-- Backfill existing review sessions so they are picked up by the 24h source-file cleanup
UPDATE sessions SET review_at = updated_at WHERE status = 'review';
