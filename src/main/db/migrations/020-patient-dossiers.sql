-- Migration 020: Patientendossiers (Epic #192 — #204, #205, #213)
-- Purpose: one migration for the whole dossier block, so later stories never
-- touch migrations/index.ts again. Only CREATE TABLE / ADD COLUMN, no table
-- rebuild — existing sessions, tasks and settings stay untouched (#204 PC 6).
--
-- dossiers          — one row per patient (#204). The *_norm columns hold the
--                     comparison key (NFC, trim, lowercase, ä→ae …). Only
--                     DossierService writes them (src/shared/utils/dossier-normalize.ts);
--                     SQL never normalizes on its own, so there is exactly one
--                     implementation of the equality rule (#204 AK 7).
-- session_dossiers  — n:m assignment of sessions to dossiers (#205). Pure
--                     reference rows without files: ON DELETE CASCADE on both
--                     sides is intended (the final DELETE FROM sessions of
--                     #202 removes the assignments, deleting a dossier removes
--                     its assignments). Never cascades from a dossier to a
--                     session — sessions have files and the two-phase delete;
--                     DossierService deletes them via SessionService.
-- sessions.document_date — date a PDF document was written (#205), ISO day.
-- recent_items      — «Zuletzt geöffnet» (#213), either a dossier or a session.
--
-- Dates are stored as ISO calendar days (YYYY-MM-DD); timestamps as ISO UTC
-- like the rest of the schema.

CREATE TABLE dossiers (
    id               TEXT PRIMARY KEY,
    first_name       TEXT NOT NULL CHECK (length(first_name) BETWEEN 1 AND 100),
    last_name        TEXT NOT NULL CHECK (length(last_name)  BETWEEN 1 AND 100),
    first_name_norm  TEXT NOT NULL,
    last_name_norm   TEXT NOT NULL,
    external_id      TEXT CHECK (external_id IS NULL OR length(external_id) BETWEEN 1 AND 50),
    external_id_norm TEXT,
    birth_date       TEXT CHECK (birth_date IS NULL OR birth_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
    diagnoses        TEXT NOT NULL DEFAULT '' CHECK (length(diagnoses)  <= 20000),
    medication       TEXT NOT NULL DEFAULT '' CHECK (length(medication) <= 20000),
    note             TEXT NOT NULL DEFAULT '' CHECK (length(note)       <= 20000),
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    CHECK ((external_id IS NULL) = (external_id_norm IS NULL))
);
CREATE UNIQUE INDEX idx_dossiers_external_id_norm ON dossiers(external_id_norm) WHERE external_id_norm IS NOT NULL;
CREATE INDEX idx_dossiers_name_norm ON dossiers(last_name_norm, first_name_norm);

CREATE TABLE session_dossiers (
    session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    dossier_id  TEXT NOT NULL REFERENCES dossiers(id) ON DELETE CASCADE,
    assigned_at TEXT NOT NULL,
    PRIMARY KEY (session_id, dossier_id)
) WITHOUT ROWID;
CREATE INDEX idx_session_dossiers_dossier ON session_dossiers(dossier_id, session_id);

ALTER TABLE sessions ADD COLUMN document_date TEXT
    CHECK (document_date IS NULL OR document_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]');

CREATE TABLE recent_items (
    id         INTEGER PRIMARY KEY,
    dossier_id TEXT REFERENCES dossiers(id) ON DELETE CASCADE,
    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    opened_at  TEXT NOT NULL,
    CHECK ((dossier_id IS NULL) <> (session_id IS NULL))
);
CREATE UNIQUE INDEX idx_recent_items_dossier ON recent_items(dossier_id) WHERE dossier_id IS NOT NULL;
CREATE UNIQUE INDEX idx_recent_items_session ON recent_items(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX idx_recent_items_opened ON recent_items(opened_at DESC, id DESC);
