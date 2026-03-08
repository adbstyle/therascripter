# Session Management

## Session Types

Every session has a `type` field that is either `audio` or `pdf`. The type is set at creation and never changes.

- **Audio sessions** are created when the user starts a recording. Displayed with a microphone icon on the session card.
- **PDF sessions** are created when the user imports a PDF file (drag-and-drop onto the dashboard or via the header import button). Displayed with a document icon on the session card.

## Status Flow

Sessions move through a linear pipeline of statuses. The exact path depends on the session type.

### Audio Pipeline

```
recording -> transcribing -> diarizing -> anonymizing -> review
```

### PDF Pipeline

```
extracting -> anonymizing -> review
```

### Error and Recovery

Any processing status can transition to `error`. From the `error` state, a session can be retried by transitioning back into any processing status.

```
Valid transitions (SessionService.VALID_TRANSITIONS):

  recording    -> transcribing | error
  transcribing -> diarizing    | error
  diarizing    -> anonymizing  | error
  extracting   -> anonymizing  | error
  anonymizing  -> review       | error
  review       -> review       | error
  error        -> recording | transcribing | diarizing | extracting | anonymizing
```

The `review -> review` self-transition supports re-anonymization (e.g., after adding a blocklist entry).

### Status Labels in the UI

| Status         | German Label         | Color       |
|----------------|----------------------|-------------|
| `recording`    | Aufnahme lauft       | Recording   |
| `transcribing` | Transkription        | Primary     |
| `diarizing`    | Sprechererkennung    | Primary     |
| `extracting`   | Textextraktion       | Primary     |
| `anonymizing`  | Anonymisierung       | Primary     |
| `review`       | Review               | Success     |
| `error`        | Fehler               | Error       |

During processing, the label is replaced with the current task name and percentage (e.g., "Transkription 42%").

## Dashboard Layout

The session dashboard (`SessionDashboard.tsx`) is the main screen of the app. Sessions are grouped by creation date into time-based sections, rendered in fixed order:

1. **Heute** -- created today
2. **Gestern** -- created yesterday
3. **Diese Woche** -- created this week (Monday-based week start)
4. **Letzte Woche** -- created last week
5. **Alter** -- older than last week

Empty groups are not rendered. Within each group, sessions appear in the order returned by the repository (newest first).

When there are no sessions at all, the dashboard shows an empty state: "Keine Sitzungen -- Starten Sie eine Aufnahme oder importieren Sie ein PDF-Dokument."

The dashboard also serves as a drag-and-drop target for PDF import. When a file is dragged over, a dashed border overlay appears with the text "PDF hier ablegen".

## Auto-Title

Sessions receive an automatic title at creation time with the format:

```
Sitzung DD.MM.YYYY HH:MM
```

For example: `Sitzung 08.03.2026 14:30`. This is generated in `recording-handlers.ts` using the local date/time at the moment the recording starts (audio) or the import is triggered (PDF).

## Session Card

Each session card (`SessionCard.tsx`) displays:

- **Type icon** -- microphone for audio, document for PDF
- **Title** -- truncated with ellipsis if too long
- **Status label** -- colored text indicating current state (see table above)
- **Error message** -- shown below the status for sessions in `error` state (up to 3 lines)
- **Progress indicator** -- visible during processing states, consisting of:
  - A horizontal progress bar showing the current task's percentage
  - Pipeline step dots: small colored circles for each pipeline step (green = completed, blue pulsing = running, red = failed, gray = pending)

The pipeline steps differ by type:
- Audio: transcription, diarization, alignment, anonymization
- PDF: extraction, OCR, anonymization

A three-dot context menu appears on hover with two actions: **Umbenennen** (rename) and **Loschen** (delete).

Sessions in `review` status are clickable and open the review editor.

## Rename

Renaming is available for any session regardless of status. The rename dialog (`RenameDialog.tsx`):

- Opens as a modal overlay with a text input pre-filled and pre-selected with the current title
- Maximum length: 200 characters
- Empty titles are not accepted (submit button is disabled)
- The title is trimmed before saving
- Dismissed via Escape key, clicking the backdrop, or the "Abbrechen" button
- Confirmed via Enter key (form submit) or the "Umbenennen" button

Renaming calls `SessionService.renameSession()` which updates only the `title` field.

## Delete

Deleting a session shows a confirmation dialog (`ConfirmDialog.tsx`) with:

- Title: "Sitzung loschen"
- Message: the session title in quotes, asking for confirmation
- A details list of what will be deleted:
  - Audiodatei (audio file)
  - Originaltext (transcript)
  - Anonymisierter Text (anonymized text)
  - Platzhalter-Mapping (entity mapping)
- Warning: "Diese Aktion kann nicht ruckgangig gemacht werden."
- Focus defaults to the "Abbrechen" (cancel) button to prevent accidental deletion
- Dismissed via Escape key or clicking the backdrop

When confirmed, `SessionService.deleteSession()` removes:

1. The audio file (`audioPath`)
2. The transcript file (`transcriptPath`)
3. The anonymized document file (`anonymizedPath`)
4. The diarization file (`diarizationPath`)
5. The PDF file (`pdfPath`)
6. The extracted text file (`extracted/<id>.json`)
7. The PCM recovery file (`recovery/<id>.pcm`)
8. The session row in the database (which cascade-deletes associated task rows)

All file deletions are best-effort -- missing files are silently skipped.

## Auto-Deletion

The `AutoDeletionService` automatically deletes sessions that are older than 30 days (based on `createdAt`).

- **Interval:** Runs immediately at app startup, then every 6 hours (`CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000`)
- **What is deleted:** Same as manual deletion -- all associated files and the database row
- **Database maintenance:** After deleting expired sessions, the service runs `PRAGMA wal_checkpoint(TRUNCATE)` and `VACUUM` to reclaim disk space
- **Source file cleanup:** The same cleanup cycle also deletes source files (audio WAV or imported PDF) for sessions that have been in `review` status for more than 24 hours. This reduces disk usage while preserving the anonymized output. The source file path in the database is set to `null` after deletion.
- **Spotlight exclusion:** The service ensures a `.metadata_never_index` marker file exists in the data directory to prevent macOS Spotlight from indexing sensitive session data.

## Orphaned Session Recovery

At app startup (`src/main/index.ts`), the `TaskQueueService.recoverOrphanedSessions()` method detects and recovers orphaned sessions.

An orphaned session is one that:
- Has a processing status (`extracting`, `transcribing`, `diarizing`, or `anonymizing`)
- Has no pending or running tasks in the task queue

This can happen if the app crashes or is force-quit during processing. Such sessions are marked with `error` status and the message "Verarbeitung wurde unerwartet abgebrochen." so the user can see what happened.

Additionally, `recoverStuckTasks()` resets any tasks that were `running` when the app shut down back to `pending` status, allowing them to be retried.

## Data Model

The `Session` interface (`src/shared/types/Session.ts`):

| Field             | Type                | Description                              |
|-------------------|---------------------|------------------------------------------|
| `id`              | `string`            | UUID                                     |
| `title`           | `string`            | User-visible name                        |
| `type`            | `'audio' \| 'pdf'`  | Session type, set at creation            |
| `status`          | `SessionStatus`     | Current pipeline stage                   |
| `audioPath`       | `string \| null`    | Path to WAV file                         |
| `transcriptPath`  | `string \| null`    | Path to transcript JSON                  |
| `anonymizedPath`  | `string \| null`    | Path to anonymized TipTap document       |
| `diarizationPath` | `string \| null`    | Path to diarization JSON                 |
| `pdfPath`         | `string \| null`    | Path to imported PDF file                |
| `entityMap`       | `EntityMap \| null` | Placeholder-to-original mapping          |
| `errorMessage`    | `string \| null`    | Error details when status is `error`     |
| `createdAt`       | `string`            | ISO timestamp of creation                |
| `updatedAt`       | `string`            | ISO timestamp of last update             |
| `reviewAt`        | `string \| null`    | ISO timestamp of first review transition |

The `reviewAt` field is set automatically on the first transition to `review` status and is never reset on subsequent re-anonymizations. It is used to determine when source files can be cleaned up (24 hours after first review).
