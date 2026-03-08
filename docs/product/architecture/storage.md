# Storage and Data Model

Therascript uses two storage mechanisms: **better-sqlite3** for structured session and blocklist data, and **electron-store** for application settings. All data is written to `~/.therascript/` on the user's machine.

---

## Database

### Location

```
~/.therascript/data/therascript.db
```

The database is opened with WAL journal mode, foreign keys enabled, `synchronous = NORMAL`, and `temp_store = MEMORY`.

### Migration System

Migrations are numbered SQL files in `src/main/db/migrations/`. At startup, `initDatabase()` creates a `schema_version` table (if it does not exist) and runs every migration whose version number exceeds the current maximum version recorded there. Each migration runs inside a transaction; on success the version number is inserted into `schema_version`. This means migrations are applied exactly once and are never re-run.

| File | Version | Change |
|---|---|---|
| `001-initial-schema.sql` | 1 | Creates `sessions`, `blocklist`, `task_queue`, `model_registry` |
| `002-add-diarization-path.sql` | 2 | Adds `diarization_path` column to `sessions` |
| `003-add-review-at.sql` | 3 | Adds `review_at` column to `sessions`; backfills existing review sessions |

---

## Tables

### `sessions`

Tracks every transcription and PDF import session.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | UUID generated at creation |
| `title` | TEXT | NOT NULL | User-visible session name |
| `type` | TEXT | NOT NULL, CHECK `audio` or `pdf` | Source type of the session |
| `status` | TEXT | NOT NULL, CHECK enum (see below) | Current processing stage |
| `audio_path` | TEXT | nullable | Absolute path to the recorded `.wav` file in `~/.therascript/audio/` |
| `transcript_path` | TEXT | nullable | Absolute path to the Whisper JSON transcript in `~/.therascript/transcripts/` |
| `diarization_path` | TEXT | nullable | Absolute path to the pyannote diarization JSON in `~/.therascript/diarization/` |
| `anonymized_path` | TEXT | nullable | Absolute path to the TipTap anonymized document JSON in `~/.therascript/anonymized/` |
| `pdf_path` | TEXT | nullable | Absolute path to the imported PDF in `~/.therascript/pdf/` |
| `entity_map` | TEXT | nullable | JSON-serialized `EntityMap` — mapping of entity IDs to original text, placeholder, type, and source |
| `error_message` | TEXT | nullable | Human-readable error string when `status = 'error'` |
| `created_at` | TEXT | DEFAULT `datetime('now')` | ISO 8601 timestamp of session creation |
| `updated_at` | TEXT | DEFAULT `datetime('now')` | ISO 8601 timestamp of last update |
| `review_at` | TEXT | nullable | ISO 8601 timestamp of when the session first reached `review` status; used for source-file cleanup |

Index: `idx_sessions_created_at` on `created_at`.

#### Session Status Enum

Status values form a directed state machine. Invalid transitions are rejected in `SessionService`.

| Status | Description |
|---|---|
| `recording` | Audio session is actively being recorded |
| `transcribing` | Whisper ASR subprocess is running |
| `diarizing` | pyannote.audio diarization + alignment is running |
| `extracting` | PDF text extraction (pdfjs + optional Vision OCR) is running |
| `anonymizing` | flair NER + blocklist replacement is running |
| `review` | Processing complete; anonymized document is ready in the Review Editor |
| `error` | Processing failed; `error_message` contains details |

Valid transitions:

```
recording    → transcribing | error
transcribing → diarizing    | error
diarizing    → anonymizing  | error
extracting   → anonymizing  | error
anonymizing  → review       | error
review       → review       | error
error        → recording | transcribing | diarizing | extracting | anonymizing
```

---

### `blocklist`

User-managed list of terms that are always anonymized regardless of NER output.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | UUID |
| `term` | TEXT | NOT NULL | The literal text to replace (case-insensitive with Umlaut normalization) |
| `placeholder_type` | TEXT | NOT NULL, CHECK enum | Which placeholder category to use for replacement |
| `created_at` | TEXT | DEFAULT `datetime('now')` | ISO 8601 timestamp |

Valid `placeholder_type` values: `PERSON`, `ORT`, `DATUM`, `KONTAKT`, `ORGANISATION`, `MEDIZINISCH`, `SONSTIGES`.

---

### `task_queue`

Tracks individual ML processing tasks within a session. Used for crash recovery and progress reporting.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | UUID |
| `session_id` | TEXT | NOT NULL, FK → `sessions(id)` ON DELETE CASCADE | Parent session |
| `type` | TEXT | NOT NULL, CHECK enum | Which ML step this task represents |
| `status` | TEXT | NOT NULL, CHECK `pending`, `running`, `completed`, `failed` | Current task state |
| `progress` | REAL | DEFAULT 0 | Completion fraction 0.0–1.0 |
| `error` | TEXT | nullable | Error message if `status = 'failed'` |
| `created_at` | TEXT | DEFAULT `datetime('now')` | ISO 8601 timestamp |
| `started_at` | TEXT | nullable | ISO 8601 timestamp when the task began execution |
| `completed_at` | TEXT | nullable | ISO 8601 timestamp when the task finished (success or failure) |

Valid `type` values: `transcription`, `diarization`, `alignment`, `extraction`, `ocr`, `anonymization`.

Indexes: `idx_task_queue_status` on `status`, `idx_task_queue_session` on `session_id`.

---

### `model_registry`

Registry of installed ML models, supporting the plugin architecture (NFR-9, NFR-10).

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | Model identifier (e.g. `whisper-large-v3-turbo`) |
| `name` | TEXT | NOT NULL | Human-readable model name |
| `task` | TEXT | NOT NULL, CHECK enum | ML task this model serves |
| `runtime` | TEXT | NOT NULL | Runtime used to run the model (e.g. `whisper.cpp`, `pyannote`, `flair`) |
| `path` | TEXT | NOT NULL | Absolute path to the model file or directory |
| `size_mb` | INTEGER | nullable | Model size in megabytes |
| `sha256` | TEXT | nullable | SHA-256 hash of the model for integrity verification |
| `bundled` | BOOLEAN | DEFAULT FALSE | Whether the model is bundled with the app (vs. downloaded) |
| `config` | TEXT | nullable | JSON-serialized model-specific configuration |
| `added_at` | TEXT | DEFAULT `datetime('now')` | ISO 8601 timestamp |

Valid `task` values: `transcription`, `diarization`, `ner`, `ocr`.

---

## Settings (electron-store)

Stored in `~/Library/Application Support/Therascript/settings.json`.

| Key | Type | Default | Description |
|---|---|---|---|
| `activeModels.transcription` | string | `'whisper-large-v3-turbo'` | Active ASR model ID |
| `activeModels.diarization` | string | `'pyannote-community-1'` | Active diarization model ID |
| `activeModels.ner` | string | `'flair-ner-german-large'` | Active NER model ID |
| `activeModels.ocr` | string | `'apple-vision'` | Active OCR model ID |
| `firstLaunchDone` | boolean | `false` | Whether the first-launch setup screen has been completed |
| `consentReminderShown` | boolean | `false` | Whether the patient consent reminder has been shown at least once |
| `modelsDownloaded` | boolean | `false` | Whether all required models have been downloaded |
| `theme` | `'light' \| 'dark' \| 'system'` | `'system'` | UI colour scheme preference |
| `installedModelVersions` | `Record<string, InstalledModelVersion>` | `{}` | Map of model ID → `{ version, sha256, installedAt }` for update tracking |
| `pendingModelUpdates` | `PendingModelUpdate[] \| null` | `null` | Model updates that have been downloaded and are staged for apply-on-restart |
| `cachedAppUpdateStatus` | `AppUpdateStatus \| null` | `null` | Last known app update check result (`{ available, latestVersion, checkedAt }`) |

---

## Filesystem Layout

All application data lives under `~/.therascript/`. Every directory is created at startup by `initDatabase()` with mode `0700` (owner read/write/execute only).

```
~/.therascript/
├── .metadata_never_index       # Prevents macOS Spotlight from indexing this directory
├── data/
│   └── therascript.db          # SQLite database (WAL mode)
├── audio/
│   └── <session-id>.wav        # Recorded audio files (16 kHz mono WAV)
├── transcripts/
│   └── <session-id>.json       # Whisper transcript output (words + timestamps)
├── diarization/
│   └── <session-id>.json       # pyannote speaker diarization segments
├── anonymized/
│   └── <session-id>.json       # TipTap document with anonymized text + entity map
├── pdf/
│   └── <session-id>.pdf        # Imported PDF files
├── extracted/
│   └── <session-id>.json       # pdfjs/Vision OCR text extraction results
├── recovery/
│   └── <session-id>.pcm        # In-progress recording buffer (raw PCM); deleted on completion
├── models/
│   ├── asr/                    # Whisper model files (~1.7 GB, Q5_0 quantized GGUF)
│   ├── diarization/            # pyannote model files (~0.2 GB)
│   └── ner/                    # flair NER model files (~2.2 GB)
```

---

## Auto-Deletion

### Session expiry (30 days)

Sessions older than 30 days (measured from `created_at`) are deleted automatically. On deletion all associated files are removed:

- `audio_path` (`.wav`)
- `transcript_path` (`.json`)
- `diarization_path` (`.json`)
- `anonymized_path` (`.json`)
- `pdf_path` (`.pdf`)
- `extracted/<session-id>.json`
- `recovery/<session-id>.pcm`

The database row is then deleted. Because `task_queue` has `ON DELETE CASCADE`, all task rows for the session are removed automatically.

### Source-file cleanup (24 hours after review)

Once a session reaches `review` status, `review_at` is stamped. Sessions that have been in `review` for more than 24 hours and still have a source file on disk (`audio_path IS NOT NULL` or `pdf_path IS NOT NULL`) have their source file deleted and the corresponding column set to `NULL`. This removes the raw patient audio or PDF while preserving the anonymized output.

### Schedule

Auto-deletion runs once immediately at app startup, then on a 6-hour interval for as long as the app is running (`CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000`). After each deletion pass, `VACUUM` and `WAL_CHECKPOINT(TRUNCATE)` are run to reclaim disk space.
