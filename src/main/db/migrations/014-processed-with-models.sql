-- Migration 014: processed_with_models column (Issue #84 Story I)
-- Purpose: persist a snapshot of the active models per pipeline group at the
-- moment processing started, so the Review-Editor can show the user which
-- model identity (id + version + sha256 + label + size) produced each
-- session.
--
-- NULL = legacy row (session reached 'review' before this commit). The UI
-- surfaces these as "Diese Sitzung wurde vor Einführung der detaillierten
-- Modell-Protokollierung verarbeitet." — no retroactive backfill, by spec.
-- Column carries a JSON-encoded ProcessedModelsSnapshot (see
-- src/shared/types/Provenance.ts) when populated.

ALTER TABLE sessions ADD COLUMN processed_with_models TEXT;
