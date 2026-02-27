-- Sitzungsverwaltung (Epic 0)
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('audio', 'pdf')),
    status TEXT NOT NULL CHECK(status IN (
        'recording', 'transcribing', 'diarizing',
        'extracting', 'anonymizing', 'review', 'error'
    )),
    audio_path TEXT,
    transcript_path TEXT,
    anonymized_path TEXT,
    pdf_path TEXT,
    entity_map TEXT,
    error_message TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at);

-- Sperrliste (Epic 5)
CREATE TABLE IF NOT EXISTS blocklist (
    id TEXT PRIMARY KEY,
    term TEXT NOT NULL,
    placeholder_type TEXT NOT NULL CHECK(placeholder_type IN (
        'PERSON', 'ORT', 'DATUM', 'KONTAKT',
        'ORGANISATION', 'MEDIZINISCH', 'SONSTIGES'
    )),
    created_at TEXT DEFAULT (datetime('now'))
);

-- Task Queue (Crash-Recovery, ML-Job-Serialisierung)
CREATE TABLE IF NOT EXISTS task_queue (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK(type IN (
        'transcription', 'diarization', 'alignment',
        'extraction', 'ocr', 'anonymization'
    )),
    status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed')),
    progress REAL DEFAULT 0,
    error TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    started_at TEXT,
    completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_task_queue_status ON task_queue(status);
CREATE INDEX IF NOT EXISTS idx_task_queue_session ON task_queue(session_id);

-- Modell-Registry (NFR-9, NFR-10)
CREATE TABLE IF NOT EXISTS model_registry (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    task TEXT NOT NULL CHECK(task IN ('transcription', 'diarization', 'ner', 'ocr')),
    runtime TEXT NOT NULL,
    path TEXT NOT NULL,
    size_mb INTEGER,
    sha256 TEXT,
    bundled BOOLEAN DEFAULT FALSE,
    config TEXT,
    added_at TEXT DEFAULT (datetime('now'))
);
