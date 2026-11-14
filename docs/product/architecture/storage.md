# Storage and Data Model

Therascript uses two storage mechanisms: **better-sqlite3** for structured session and blocklist data, and **electron-store** for application settings. All data is written to `~/.therascript/` on the user's machine.

---

## Database

### Location

```
~/.therascript/data/therascript.db
```

The database is opened with WAL journal mode, foreign keys enabled, `synchronous = NORMAL`, `temp_store = MEMORY` and `secure_delete = ON` (per connection, set on every open — see «Deleting a session» below).

### Migration System

Migrations are numbered SQL files in `src/main/db/migrations/`. At startup, `initDatabase()` creates a `schema_version` table (if it does not exist) and runs every migration whose version number exceeds the current maximum version recorded there. Each migration runs inside a transaction; on success the version number is inserted into `schema_version`. This means migrations are applied exactly once and are never re-run.

| File | Version | Change |
|---|---|---|
| `001-initial-schema.sql` | 1 | Creates `sessions`, `blocklist`, `task_queue`, `model_registry` |
| `002-add-diarization-path.sql` | 2 | Adds `diarization_path` column to `sessions` |
| `003-add-review-at.sql` | 3 | Adds `review_at` column to `sessions`; backfills existing review sessions |
| … | … | (see `src/main/db/migrations/index.ts`) |
| `017-session-deleting-at.sql` | 17 | Adds `deleting_at` to `sessions` — restart-proof deletion (#202); existing rows stay `NULL` |
| `018-app-maintenance.sql` | 18 | Adds `app_maintenance(task, done_at)` and records the one-time `secure-delete-vacuum` as pending (#202) |

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
| `deleting_at` | TEXT | nullable | Set when the user confirmed the deletion and its files are not all removed yet (#202). Rows with a value are hidden from every read that reaches the user (`findById`, `findAll`, source-file cleanup) |
| `title_entity_snapshot` | TEXT | nullable | Issue #203 (migration 019): JSON `{ "[PERSON 1]": "Ruth Gerber", … }` — meaning of the placeholder tokens in `title` when it was written. The Klartext view resolves a token only while `entity_map` still gives it this meaning (`shared/utils/resolvePlaceholders.ts`) |
| `summary_entity_snapshot` | TEXT | nullable | Same for `summary`; written by the summarization (from the EntityMap read with the LLM input) and on user edits (only tokens absent from the old text count as newly typed and get the current meaning; tokens of the old text keep their record — or, without one, stay placeholders for good). Migration 019 backfilled existing rows with today's unambiguous meanings, reading only object entries of valid maps (never fails on malformed legacy data) |
| `title_plain` / `summary_plain` | TEXT | nullable | Issue #203: Klartext of `title`/`summary`, computed on every write that can change it (`SessionRepository.update` → `db/plainTexts.ts`, incl. `review:save`'s entity_map). NULL = same as the raw text. The session list selects only these — never `entity_map` or the snapshots. Existing rows: one-time `placeholder-plain-backfill` in `runStartupMaintenance` (`app_maintenance`) |

All four #203 columns hold clear names and are cleared by `scrubMarkedContent` together with title, summary and entity_map.

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
| `autoUpdate` | `boolean` | `true` | Automatic updates of app and models (#165, #167) |
| `appUpdate` | `PersistedUpdate \| null` | `null` | Selected update (app part, models, install journal) — see model-management.md |
| `startHiddenAfterUpdate` | `boolean` | `false` | Relaunch after an update with a hidden window (#164) |

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
│   ├── asr/                    # Whisper model files (~0.6 GB, Q5_0 quantized GGUF)
│   ├── diarization/            # pyannote model files (~0.06 GB)
│   ├── ner/                    # flair NER model files (~1.1 GB, fp16)
│   └── .update/                # staged model updates (<sha256>/payload) and backups during
│                               #   the swap (#167) — survives restarts, same volume as models/
```

The staged app of an update lives outside `~/.therascript/`, in `<userData>/app-update/<version>/` (same volume as the app bundle).

---

## Retention and Deletion

Sessions are kept until the user deletes them (#202). There is no age-based deletion — the 30-day auto-deletion of earlier versions is gone. Only the source file of a successfully processed session is removed automatically.

### Source-file cleanup (24 hours after review)

Once a session reaches `review` status, `review_at` is stamped. Sessions that have been in `review` for more than 24 hours and still have a source file on disk (`audio_path IS NOT NULL` or `pdf_path IS NOT NULL`) have their source file deleted and the corresponding column set to `NULL`. This removes the raw patient audio or PDF while preserving the text, the pseudonymization, title and summary. Failed sessions never reach `review`, so their recording or PDF stays for a later retry — however old the session is.

`SourceFileCleanupService` runs this once at app startup, then every 6 hours (`CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000`). It deletes no rows, so it needs neither `VACUUM` nor a checkpoint.

### Deleting a session

`SessionService.deleteSession()` works in two phases, so an interrupted deletion is finished at the next start (#202, Postcondition 2):

1. **Mark:** `deleting_at` is set. From now on the session is gone for the user and for any executor still writing (`update()` returns `null`).
2. **Remove:** abort the session's tasks (`TaskQueueService.abortRunningForSession`), remove every file the session can have — the stored paths plus the convention paths (`audio/<id>.wav`, `transcripts/<id>.json`, `transcripts/<id>-aligned.json`, `diarization/<id>.json`, `anonymized/<id>.json`, `pdf/<id>.pdf`, `extracted/<id>.json`, `recovery/<id>.pcm`) — delete the row (`task_queue` follows via `ON DELETE CASCADE`) and run `PRAGMA wal_checkpoint(TRUNCATE)`.

If a file cannot be removed (anything but «does not exist»), the row stays marked; its title, summary, entity map and error message are cleared immediately, the paths stay for the retry. At startup — before the task queue and the IPC handlers — `finishPendingDeletions()` completes every marked row, then `sweepOrphanedSessionFiles()` removes files in the session folders whose name is `<uuid>…` and whose session no longer exists in the database (leftovers of a crash, of a pre-#202 deletion, or of an executor that wrote after the deletion). Files with any other name are never touched.

**Why nothing is recoverable from the app's files (Postcondition 1):**

- `secure_delete = ON` makes SQLite overwrite deleted rows and freed pages (including overflow pages of large entity maps) with zeros instead of leaving them as free space.
- In WAL mode the zeroed pages first land in the `-wal` file, while older frames there and the main file may still hold the content. The `wal_checkpoint(TRUNCATE)` after every deletion writes the zeroed pages into `therascript.db` and truncates the WAL to zero bytes.
- `SessionService.secureDelete.test.ts` checks this on a real database file: a marker string in title, summary, error message and a multi-page entity map is found in neither `.db` nor `-wal` after the deletion; a control without `secure_delete` shows that the search would find it.
- `secure_delete` only covers content freed from now on. Databases of earlier versions may still hold old row versions (entity maps with real names, sessions deleted by the 30-day rule) in free pages. `runStartupMaintenance()` (`src/main/db/maintenance.ts`, called by `initDatabase` after the migrations) therefore runs **one** `VACUUM` after the update: migration 018 records the step as pending, `done_at` is set only after the `VACUUM` succeeded, so an interrupted start repeats it. `VACUUM` cannot run inside a transaction, which is why it is not a migration. A failing `VACUUM` (e.g. disk full) is logged and retried at the next start; the app still starts. Tested in `maintenance.test.ts` (legacy file without `secure_delete`, marker gone after `initDatabase`, second start does not vacuum again).
- `runStartupMaintenance()` also runs `wal_checkpoint(TRUNCATE)` at every start. This finishes a checkpoint that was blocked (`busy ≠ 0` — logged by `SessionService` after a deletion) and closes the gap «crash between commit of the deletion and checkpoint».
- After every executor run `TaskQueueService` calls `SessionService.removeFilesIfDeleted()`: if the session was deleted meanwhile, files an executor wrote after the abort are removed again with the same code as the deletion (`PDFExtractionExecutor` also checks the signal before writing).
- Apart from that one-time step there is no `VACUUM`: with `secure_delete` nothing readable is left in free pages; a periodic `VACUUM` would only shrink the file.
- Files are removed with `unlink`, not overwritten. On APFS (copy-on-write) and SSDs (wear levelling) overwriting a file in place does not reach the original blocks, so it would add no protection; FileVault (checked at startup) is what protects freed blocks.
- Out of scope: copies in Time Machine backups or APFS snapshots of the Mac.
