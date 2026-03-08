-- Add 'cancelled' to task_queue status CHECK constraint
-- SQLite requires table recreation to alter CHECK constraints
CREATE TABLE IF NOT EXISTS task_queue_new (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK(type IN (
        'transcription', 'diarization', 'alignment',
        'extraction', 'ocr', 'anonymization'
    )),
    status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
    progress REAL DEFAULT 0,
    error TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    started_at TEXT,
    completed_at TEXT
);

INSERT INTO task_queue_new SELECT * FROM task_queue;
DROP TABLE task_queue;
ALTER TABLE task_queue_new RENAME TO task_queue;

CREATE INDEX IF NOT EXISTS idx_task_queue_status ON task_queue(status);
CREATE INDEX IF NOT EXISTS idx_task_queue_session ON task_queue(session_id);
