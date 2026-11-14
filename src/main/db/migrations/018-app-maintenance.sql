-- Migration 018: app_maintenance (Issue #202)
-- Purpose: one-time maintenance steps that cannot run inside the migration
-- transaction. The migration only records the step as pending; runStartupMaintenance()
-- (src/main/db/maintenance.ts) executes it after the migrations and sets done_at.
--
-- secure-delete-vacuum: secure_delete (since #202) only zeroes content freed
-- from now on. Older versions of rows (entity maps with real names, sessions
-- deleted by earlier versions) may still sit in free pages — a single VACUUM
-- rebuilds the file without them.

CREATE TABLE IF NOT EXISTS app_maintenance (
  task TEXT PRIMARY KEY,
  done_at TEXT
);

INSERT OR IGNORE INTO app_maintenance (task, done_at) VALUES ('secure-delete-vacuum', NULL);
