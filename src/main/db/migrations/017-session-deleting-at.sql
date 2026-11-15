-- Migration 017: deleting_at column (Issue #202)
-- Purpose: make deleting a session restart-proof. SessionService.deleteSession
-- first stamps the row with deleting_at (phase 1, durable), then cancels tasks,
-- removes the files and deletes the row (phase 2). A row that still carries
-- deleting_at at the next start was interrupted (crash, power loss) or a file
-- could not be removed — finishPendingDeletions() completes it before the
-- task queue starts. Rows with deleting_at are hidden from every read that
-- reaches the user (list, detail, source-file cleanup).
--
-- NULL = regular session. Existing rows keep NULL, so the update leaves every
-- session untouched (Issue #202, Postcondition 3).

ALTER TABLE sessions ADD COLUMN deleting_at TEXT;
