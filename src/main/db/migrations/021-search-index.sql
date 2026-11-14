-- Migration 021: Suchindex (Epic #192 — #209, #210, #211, #212)
-- Purpose: one migration for the whole search block. Only CREATE TABLE /
-- ADD COLUMN, no table rebuild — existing sessions, tasks, dossiers and
-- settings stay untouched (Epic NFR 7).
--
-- sessions.search_rev  — rises with every change of searchable content (title,
--                        summary, document/EntityMap, status → review). Only
--                        SessionRepository.update writes it.
-- search_index_state   — per session: active text generation (exact search)
--                        and active vector generation (search by meaning,
--                        filled from PR S4 on). A session is "to be indexed"
--                        while text_rev < search_rev (or no row exists — the
--                        stock before the update falls under the same rule,
--                        #210 AK 1). doc_stat = size:mtime of the document
--                        file when it was indexed (startup check against a
--                        crash between file write and DB update).
-- search_chunks        — sections of ~200 words in CLEAR TEXT (chips as their
--                        original). Two generations per session may coexist:
--                        the new text generation is active for the exact
--                        search right away, the old one stays only while an
--                        active vector generation still points at it.
--                        `units` (JSON) maps each unit back to the TipTap
--                        paragraph: [{p, s, e, o, pfx, spk?, ts?}].
--                        vec/vec_scale stay NULL until PR S4 (int8[768]).
-- search_fts           — trigram index over the normalized text
--                        (normalizeSearchText of the unit texts). Stores its
--                        own copy of that normalized text (a regular,
--                        "contentful" FTS5 table): DELETE then reads the stored
--                        value and removes every entry from the index pages.
--                        'secure-delete' (stored per table) makes FTS5 rewrite
--                        those pages instead of keeping the trigrams. Measured
--                        with the bundled SQLite 3.51.2 (PR S3): a contentless
--                        table with contentless_delete=1 — the variant of the
--                        Bauplan — records deletes as tombstones and keeps
--                        every trigram of a deleted session in
--                        search_fts_data, WITH or without 'secure-delete'.
--                        detail=full (default) is required for phrase queries.
-- search_recent_queries — the five last searches (#209 AK 27/28, PC 2–4).
--
-- Clear text in the index: every row hangs on sessions(id) ON DELETE CASCADE;
-- the trigger removes the FTS entry; together with PRAGMA secure_delete and
-- the WAL checkpoint of the existing delete path nothing remains in .db/-wal.

ALTER TABLE sessions ADD COLUMN search_rev INTEGER NOT NULL DEFAULT 0;

CREATE TABLE search_index_state (
    session_id      TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    text_gen        INTEGER NOT NULL,
    text_rev        INTEGER NOT NULL,
    vec_gen         INTEGER,
    model_id        TEXT,
    dirty_since     TEXT,
    attempts        INTEGER NOT NULL DEFAULT 0,
    last_error      TEXT,
    next_attempt_at TEXT,
    doc_stat        TEXT
) WITHOUT ROWID;

CREATE TABLE search_chunks (
    id         INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    gen        INTEGER NOT NULL,
    field      TEXT NOT NULL CHECK (field IN ('title', 'summary', 'body')),
    ord        INTEGER NOT NULL,
    para_from  INTEGER,
    para_to    INTEGER,
    units      TEXT NOT NULL,
    text       TEXT NOT NULL,
    vec        BLOB,
    vec_scale  REAL
);
CREATE INDEX idx_search_chunks_session ON search_chunks(session_id, gen);
CREATE INDEX idx_search_chunks_pending ON search_chunks(session_id, gen) WHERE vec IS NULL;

CREATE VIRTUAL TABLE search_fts USING fts5(
    norm,
    tokenize = 'trigram'
);
INSERT INTO search_fts(search_fts, rank) VALUES ('secure-delete', 1);

CREATE TRIGGER search_chunks_ad AFTER DELETE ON search_chunks BEGIN
    DELETE FROM search_fts WHERE rowid = old.id;
END;

CREATE TABLE search_recent_queries (
    id         INTEGER PRIMARY KEY,
    query      TEXT NOT NULL CHECK (length(query) BETWEEN 1 AND 200),
    query_norm TEXT NOT NULL UNIQUE,
    used_at    TEXT NOT NULL
);
