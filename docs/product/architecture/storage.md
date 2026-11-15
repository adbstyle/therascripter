# Storage and Data Model

Therascript uses two storage mechanisms: **better-sqlite3** for structured session, patient-dossier and blocklist data, and **electron-store** for application settings. All data is written to `~/.therascript/` on the user's machine.

---

## Database

### Location

```
~/.therascript/data/therascript.db
```

The database is opened with WAL journal mode, foreign keys enabled, `synchronous = NORMAL`, `temp_store = MEMORY` and `secure_delete = ON` (per connection, set on every open — see «Deleting a session» below).

### Migration System

Migrations are numbered SQL files in `src/main/db/migrations/`. At startup, `initDatabase()` creates a `schema_version` table (if it does not exist) and runs every migration whose version is not yet recorded there, in ascending order (`runMigrations` in `connection.ts`). Each migration runs inside a transaction; on success the version number is inserted into `schema_version`. This means migrations are applied exactly once and are never re-run — and a version merged later than a higher one (e.g. 019 after a database already has 020) is still applied instead of being skipped. `migration-019.test.ts` keeps the version list unique, ascending and gap-free; `migrations.test.ts` tests the real runner.

| File | Version | Change |
|---|---|---|
| `001-initial-schema.sql` | 1 | Creates `sessions`, `blocklist`, `task_queue`, `model_registry` |
| `002-add-diarization-path.sql` | 2 | Adds `diarization_path` column to `sessions` |
| `003-add-review-at.sql` | 3 | Adds `review_at` column to `sessions`; backfills existing review sessions |
| … | … | (see `src/main/db/migrations/index.ts`) |
| `017-session-deleting-at.sql` | 17 | Adds `deleting_at` to `sessions` — restart-proof deletion (#202); existing rows stay `NULL` |
| `018-app-maintenance.sql` | 18 | Adds `app_maintenance(task, done_at)` and records the one-time `secure-delete-vacuum` as pending (#202) |
| `019-placeholder-snapshots.sql` | 19 | Adds `title_entity_snapshot`, `summary_entity_snapshot`, `title_plain`, `summary_plain` to `sessions` (#203) |
| `020-patient-dossiers.sql` | 20 | Patient dossiers for the whole Epic #192 block: `dossiers`, `session_dossiers`, `recent_items`, `sessions.document_date`. Only `CREATE TABLE` / `ADD COLUMN`, existing rows untouched (#204 PC 6) |
| `021-search-index.sql` | 21 | Search index for #209–#212: `sessions.search_rev`, `search_index_state`, `search_chunks`, `search_fts` (FTS5 trigram, `secure-delete`), trigger `search_chunks_ad`, `search_recent_queries`. Only `CREATE TABLE` / `ADD COLUMN`, existing rows untouched; the stock is indexed by the text phase afterwards (#210 AK 1) |

**Table rebuilds and foreign keys.** `task_queue`, `session_dossiers`, `recent_items`, `search_index_state` and `search_chunks` reference `sessions` with `ON DELETE CASCADE`. A rebuild of `sessions` (CREATE new → DROP old → RENAME) with foreign keys on deletes all tasks, all dossier assignments and all «recently opened» entries — `DROP TABLE` runs an implicit `DELETE FROM` whose cascade fires immediately. `PRAGMA defer_foreign_keys = ON` does **not** prevent this (it defers constraint *checks*, not `ON DELETE` *actions*; proven in `020-patient-dossiers.test.ts`). Only `PRAGMA foreign_keys = OFF` does, and it has no effect inside a transaction — the runner must be extended (FK off before the migration's transaction, `PRAGMA foreign_key_check`, FK on) before such a migration is written. See the rule comment in `src/main/db/migrations/index.ts`.

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
| `document_date` | TEXT | nullable, CHECK `YYYY-MM-DD` | Date a PDF document was written (#205); `NULL` = use the local import day (migration 020). Written only by `SessionService.setDocumentDate` (PDFs only, valid day not after today, never back to `NULL`); removed with the row when the PDF is deleted (#205 PC 6) |
| `search_rev` | INTEGER | NOT NULL DEFAULT 0 | Migration 021: rises with every change of searchable content — title, summary, entity map/document (`review:save`, pseudonymization), status → `review` — in `SessionRepository.update`. Not on path, counter or progress updates. `0` = never changed since the update (stock, #210) |
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

### `dossiers`

One row per patient dossier (#204). Stored only locally and kept without time limit until the user deletes it or removes Therascript completely.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | UUID |
| `first_name`, `last_name` | TEXT | NOT NULL, 1–100 characters | Display form: NFC-composed and trimmed |
| `first_name_norm`, `last_name_norm` | TEXT | NOT NULL | Comparison key (see below) |
| `external_id` | TEXT | nullable, 1–50 characters | Patient dossier ID (e.g. from the practice software); an empty input is stored as `NULL` |
| `external_id_norm` | TEXT | nullable, UNIQUE where not `NULL` | Comparison key of `external_id`; `NULL` exactly when `external_id` is `NULL` |
| `birth_date` | TEXT | nullable, CHECK `YYYY-MM-DD` | Valid calendar day, not after today (validated in Zod and `DossierService`) |
| `diagnoses`, `medication`, `note` | TEXT | NOT NULL DEFAULT `''`, ≤ 20 000 characters | Multi-line free text |
| `created_at`, `updated_at` | TEXT | NOT NULL | ISO 8601 UTC |

Indexes: `idx_dossiers_external_id_norm` (partial unique), `idx_dossiers_name_norm` on `(last_name_norm, first_name_norm)` — the sort order of the overview.

**Equality rule (#204 AK 7).** Names and dossier IDs are equal when they differ only in case, leading/trailing whitespace or the spelling of umlauts. The comparison key is `normalizeDossierKey()` (`src/shared/utils/dossier-normalize.ts`): NFC (macOS delivers some input decomposed), trim, lowercase (`de-CH`), then ä→ae, ö→oe, ü→ue, ß→ss (so ẞ → ß → ss). Only `DossierService` writes the `*_norm` columns; SQL never normalizes on its own, so there is one implementation. The overview sorts by `last_name_norm, first_name_norm, id` — ä sorts as ae, consistent with the equality rule.

### `session_dossiers`

n:m assignment of sessions to dossiers (#205). `WITHOUT ROWID`, primary key `(session_id, dossier_id)`, `assigned_at` ISO UTC, index `idx_session_dossiers_dossier` on `(dossier_id, session_id)`. Both foreign keys are `ON DELETE CASCADE`: these are pure reference rows without files. Deleting a session (final `DELETE FROM sessions` of #202) removes its assignments; deleting a dossier removes its assignments. Unassigning (`SessionDossierService.unassign`) deletes the row and runs `wal_checkpoint(TRUNCATE)` right after, so with `secure_delete` the assignment is neither in `.db` nor in `-wal` (#205 PC 5). The timeline query computes the local day with `date(s.created_at, 'localtime')` (or `document_date` for PDFs) in SQLite and returns it as `sortDay`. There is **never** a cascade from a dossier to a session — sessions have files, tasks and the two-phase deletion; `DossierService` deletes them via `SessionService` (see «Deleting a patient dossier»).

### `recent_items`

«Recently opened» (#213): `id` INTEGER PRIMARY KEY, exactly one of `dossier_id` / `session_id` (CHECK), each `ON DELETE CASCADE` and unique where not `NULL`, `opened_at` ISO UTC, index on `(opened_at DESC, id DESC)`. Written only by `RecentRepository.touch` (upsert, `opened_at` strictly increasing, then everything beyond the eight newest is deleted); survives restarts (PC 1). Deletion (PC 2): deleting a dossier removes its row via the cascade inside the delete transaction; marking a session for deletion (`SessionRepository.markDeleting`, also from the dossier delete) deletes its row **at once** — not only with the final `DELETE FROM sessions`, which may wait for the staged index purge or the next start — and `scrubMarkedContent` repeats it; the delete paths' `secure_delete` + `wal_checkpoint(TRUNCATE)` remove the bytes. `RecentRepository.list` additionally filters `deleting_at IS NULL`. `RecentService.test.ts` scans `.db` and `-wal` for the IDs after deleting a dossier, its exclusive session and a single session.

---

### Search index (migration 021, Epic #192)

Feature description: `docs/product/features/search.md`. Everything here holds **clear text** (chips as their original) and hangs on `sessions(id) ON DELETE CASCADE`.

| Table | Content |
|---|---|
| `search_index_state` | One row per indexed session (`WITHOUT ROWID`): `text_gen`/`text_rev` = active text generation for the exact search and the `search_rev` it was built from; `vec_gen`/`model_id` = active vector generation for the search by meaning (PR S4: set to `text_gen` once every summary and text section of it has a vector — title sections never get one, they are found exactly only; `model_id` names the model of those vectors — another model makes them stale); `search_chunks.vec` int8[768] + `vec_scale` (max\|v\| / 127), written per batch of 2; `dirty_since`, `attempts`/`last_error`/`next_attempt_at` (also the vector phase's backoff 1 min, 5 min, 30 min, 6 h; a new text generation clears `next_attempt_at` while fewer than 3 failures are counted, `attempts` returns to 0 only after a successful vector generation) (`last_error` is set by the text phase when the document could not be read — title and summary are indexed anyway), `doc_stat` (`size:mtime` of the document file when indexed — the loop compares it after the start, against a crash between file write and DB update in `review:save`). No row = never indexed (the stock before the update) |
| `search_chunks` | Sections of ~200 words: `session_id`, `gen`, `field` (`title`/`summary`/`body`), `ord`, `para_from`/`para_to` (paragraph indices in `doc.content`), `units` (JSON `[{p, s, e, o, pfx, spk?, ts?}]` — paragraph, clear-text range `[s,e)` in it, offset of the line in `text`, prefix length, speaker label and timestamp of the paragraph), `text` («Sprecher N: …» per unit, PDFs «Bericht: …»), `vec`/`vec_scale` (int8 vector; `NULL` until the vector phase has embedded the section, and always for `title` — titles take part only in the exact search; vectors of titles written by an earlier version are ignored). Indexes on `(session_id, gen)` and, partial, `WHERE vec IS NULL` |
| `search_fts` | FTS5, `tokenize='trigram'`, detail full, **with its own copy** of the normalized unit texts (`normalizeSearchText`, no speaker prefixes); `rowid` = `search_chunks.id`. Option `secure-delete = 1` (stored in `search_fts_config`). Trigger `search_chunks_ad` deletes the FTS row with its chunk — also on the cascade from `sessions` |
| `search_recent_queries` | The five last searches: `query` (1–200 characters), `query_norm` UNIQUE (normalized, whitespace collapsed — the dedup key), `used_at` (strictly increasing) |

**Why not contentless.** The Bauplan proposed `content='', contentless_delete=1`. With the bundled SQLite 3.51.2 such a table records a delete as a tombstone and keeps every trigram of the deleted session in `search_fts_data` — with or without `secure-delete` (raw-byte test, PR S3). A regular FTS5 table removes the entries from the index pages on `DELETE`, and with `secure-delete` the pages are rewritten without them. Price: the normalized text is stored twice (~100 MB at 2'000 sessions). `search.secureDelete.test.ts` fails for both the contentless variant and a missing `secure-delete`.

**Two generations.** The text phase writes a new generation (`gen` + 1) with its FTS rows and makes it active in **one** transaction. Older generations (except the one an active `vec_gen` points to; until S4 `vec_gen` is always `NULL`) are invisible at once through the join on `text_gen`; the background loop of `SearchIndexService` deletes them section by section in short slices — deleting with `secure-delete` costs ~20–40 ms per section, a two-hour session in one piece blocked the main process for seconds.

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
| `sidebarOpen` | boolean | `true` | Sidebar of the app shown (Epic #192); toggled via the title-bar button or ⌃⌘S |
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

### Source-file cleanup (at the earliest 24 hours after review)

Once a session reaches `review` status, `review_at` is stamped. Sessions that have been in `review` for more than 24 hours and still have a source file on disk (`audio_path IS NOT NULL` or `pdf_path IS NOT NULL`) have their source file deleted and the corresponding column set to `NULL`. This removes the raw patient audio or PDF while preserving the text, the pseudonymization, title and summary. Failed sessions never reach `review`, so their recording or PDF stays for a later retry — however old the session is.

`SourceFileCleanupService` runs this once at app startup, then every 6 hours (`CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000`). It deletes no rows, so it needs neither `VACUUM` nor a checkpoint.

**When exactly:** a source file is deleted **at the earliest 24 hours** after the session reached `review` (successful processing) and **at the latest at the next cleanup run after that** — so 24 to ~30 hours while the app keeps running. Runs only happen while the app runs: a Mac that is off or an app that is quit postpones the deletion to the next start (which runs the cleanup at once). Public texts (README, website, Datenschutzerklärung, AboutPage) say «frühestens 24 Stunden nach erfolgreicher Verarbeitung, sobald die App das nächste Mal aufräumt (beim Start und alle 6 Stunden, solange sie läuft)» — keep them in sync with this rule.

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
- **Search index (#209 PC 1):** the clear-text sections, their FTS rows (incl. FTS5's own copy of the normalized text) and the index state go with the row via `ON DELETE CASCADE` and the trigger `search_chunks_ad`; `secure-delete` on `search_fts` makes FTS5 rewrite its index pages without the deleted trigrams, and the checkpoint above moves the zeroed pages into the file. Every search query filters `deleting_at IS NULL AND status = 'review'`, so a marked session is unfindable at once. **Staged while the app runs:** `completeDeletion` does not delete a row that still has index rows; it clears title, summary and entity map (`scrubMarkedContent`) and hands the session to the loop of `SearchIndexService`, which deletes its sections in slices of ~15 ms work plus commit (one transaction per slice) right away and then calls `finishDeletion` (row, checkpoint). The IPC call returns after a few ms and `sessions:changed` goes out at once; a 50-minute session is physically gone after ~1.5 s, a dossier with 10 sessions after ~14 s (2'000 sessions, M5 Pro). If the app ends in between, the row stays marked and `finishPendingDeletions()` deletes it in one piece at the next start (the loop does not run yet). If files could not be removed, the loop still removes the index rows (`schedulePurge(id, false)`) and checkpoints. Checked in `src/main/search/__tests__/search.secureDelete.test.ts` (marker in text, chip original and title; its normalized form and every trigram are searched in `.db` and `-wal` after `deleteSession` and `deleteDossier`; a counter-check without `secure-delete` finds them).
- Out of scope: copies in Time Machine backups or APFS snapshots of the Mac.

### Deleting a patient dossier

`DossierService.deleteDossier(id, fingerprint)` (#204, #207) reuses the session deletion of #202:

1. **One transaction:** recompute the delete preview (`deletePreview`). If its fingerprint (SHA-256 over the sorted IDs of exclusively and of shared assigned sessions) no longer matches the one the user confirmed, nothing is deleted and the new preview is returned (`reason: 'changed'`). If an exclusively assigned session is being recorded, nothing is deleted (`'blocked-recording'`). Otherwise the exclusively assigned sessions are marked (`SessionService.markForDeletion` → `deleting_at`) and the dossier row is deleted; its assignments and «recently opened» entry follow via `ON DELETE CASCADE`. After the commit the dossier is gone atomically — no `deleting_at` column for dossiers is needed — and the marked sessions are invisible to every read.
2. **After the commit:** each marked session is finished with `SessionService.finishDeletion` (abort tasks, remove files and row). If one fails, the result says `incomplete: true` and `finishPendingDeletions()` completes it at the next start (#204 PC 5). Then `wal_checkpoint(TRUNCATE)`; with `secure_delete` no copy of the dossier stays in `.db` or `-wal` (#204 PC 4). A crash between commit and checkpoint is covered by the checkpoint at every start.

In the same transaction the five last searches lose every query containing the dossier's first name, last name or dossier ID (`SearchRecentRepository.forgetContaining`, #209 PC 4); the checkpoint of step 2 removes them from the files.

Sessions shared with another dossier stay; they only lose this assignment. Processing of a deleted session ends at once: `finishDeletion` calls `TaskQueueService.abortRunningForSession`, which aborts the running executor's signal (the subprocess is killed via `runSubprocess`) and cancels its pending tasks; waiting sessions never start (#207 PC 2). Tested in `DossierService.test.ts`, `DossierService.cascadeDelete.test.ts` (only exclusive contents go, blocklist untouched, running and waiting processing ends — also when phase 2 stays incomplete —, deleted contents vanish at once from session list, other timelines, overview and search while their rows and index sections still exist, search data in the preview) and, on a real database file with a marker string, in `DossierService.secureDelete.test.ts` (including an interrupted deletion completed by a restart).

### Recent searches

«Verlauf löschen» deletes all rows of `search_recent_queries` and runs `wal_checkpoint(TRUNCATE)` (#209 PC 3). Queries pushed out of the five are deleted without a checkpoint; the next checkpoint (any deletion, every start) takes their pages along.

### Removing Therascript completely

«TheraScript vollständig entfernen» (Settings → Über, and the native confirmation dialog in `system-handlers.ts`) deletes `~/.therascript/` — including the database with every patient dossier — and the settings folder. Moving only the app to the Bin keeps all data.
