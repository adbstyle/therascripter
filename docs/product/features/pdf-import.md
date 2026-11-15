# PDF Import

## Overview

Therascript can anonymize existing PDF documents (e.g. reports, referrals, discharge letters). Users import PDFs via drag-and-drop onto the session dashboard or through a file picker button. The original file is never modified -- a copy is stored in `~/.therascript/pdf/` and processed through a three-stage pipeline: text extraction, optional OCR for scanned pages, and NER-based anonymization.

## Import Methods

### Drag-and-Drop

The `SessionDashboard` component registers drag-and-drop handlers on its root container. When the user drags files over the dashboard, a visual overlay appears ("PDF hier ablegen" with a dashed border and highlighted background). On drop, the component filters for `.pdf` files, resolves native file paths via `webUtils.getPathForFile()`, and calls `importPdfs(pdfPaths)` from `useWorkspaceActions()`. Non-PDF files in the drop are silently ignored.

### File Picker Button

The «PDF importieren» button in the page header of «Transkriptionen» and the import icon next to «Transkriptionen» in the sidebar both call `importPdfs()` from `useWorkspaceActions()` (`src/renderer/src/contexts/WorkspaceActionsContext.tsx`, Epic #192). Without paths it calls `window.api.import.showPDFDialog()`, which opens a native macOS file dialog (`dialog.showOpenDialog`) configured for multi-selection with a `.pdf` file filter. The dialog title reads "PDF-Dokumente zum Anonymisieren auswahlen". If the user cancels, an empty array is returned and no session is created.

**Import from a patient dossier (#206):** «PDF importieren» in the head of a dossier page and PDFs dropped onto its timeline call `importPdfs(paths?, { dossierId, dossierName })`. The main process assigns every PDF to the dossier right after creating its session and **before** `enqueuePipeline` — no processing step ever runs on an unassigned PDF from a dossier (PC 2). If the assignment fails (dossier deleted meanwhile, database error), the PDF is imported anyway; `import:pdf` returns it in `unassigned` and the renderer shows a 10-second error toast naming every such PDF by title and the dossier «Nachname, Vorname» (AK 2). Importing outside a dossier never asks for one (OOS 1).

All entry points share one `isImporting` flag that prevents concurrent imports. The flag is cleared in a `finally` block so it resets even if the import fails. The list shows the new sessions because the main process fires `sessions:changed` on session creation — no manual refresh.

## File Handling and Session Creation

For each selected file, the `import:pdf` IPC handler in `pdf-handlers.ts` performs these steps:

1. **Validation** -- Checks that the file exists and has a `.pdf` extension; otherwise it lands in `failed` («Datei nicht gefunden», «Keine PDF-Datei») and the next file follows. **Every file is handled in its own try/catch** (review #225): a missing file, a copy failure or a database error never aborts the whole import — earlier and later PDFs stay imported and reported.
2. **Session creation** -- Calls `SessionService.createSession(title, 'pdf')`, which inserts a new session with status `extracting` (audio sessions start as `recording`). The session title is derived from the PDF filename; if the name is empty or literally "document", a timestamp-based fallback is used (`PDF DD.MM.YYYY HH:MM`).
2a. **Dossier assignment (#206)** -- With `dossierId`: `SessionDossierService.assign(session.id, dossierId)`; a failure (result or exception) adds `{ sessionId, title }` to `unassigned` and the import goes on.
3. **File copy** -- Copies the source file to `~/.therascript/pdf/<sessionId>.pdf` using `copyFileSync`. The original file is never moved or modified.
4. **Path storage** -- Updates the session record with the `pdfPath` pointing to the copied file.
5. **Pipeline enqueue** -- Calls `taskQueue.enqueuePipeline(sessionId, 'pdf')` to schedule the three processing tasks.
6. **Deleted while waiting** -- After the `await` of the scanned-pages check the handler checks that the session still exists. If the user deleted the PDF (or its only dossier, which takes the PDF along) meanwhile, it is skipped silently — no error, no enqueue.
7. **Result** -- `{ sessions, unassigned, failed: {title, reason}[] }`; lists and timelines reload on `sessions:changed`/`dossiers:changed`. The renderer shows one error toast (stays while hovered or focused, close button) naming how many PDFs were imported, which could not be imported and why, and which could not be assigned; a rejected call shows «Der Import ist fehlgeschlagen. Bitte versuchen Sie es erneut.». The shared `isImporting` guard is unchanged.

PDF import is also available while an audio recording is running; the imported session then stays in `queued` ("Wartet") until the recording stops, because the task queue is paused for the duration of the recording (see [transcription-pipeline.md](transcription-pipeline.md)).

### Copy Failure Rollback

If `copyFileSync` fails (e.g. source is on an ejected volume, permission denied, disk full), the handler rolls back that file and continues with the next:

- Deletes the just-created session via `sessionService.deleteSession(session.id)`.
- Attempts to remove any partial file at the target path (`unlinkSync`, errors silently ignored).
- Reports the file in `failed` with «Die Datei konnte nicht kopiert werden. Ist sie lokal verfügbar?» (the system error goes to the log).

### Orphaned Session Recovery

Sessions that get stuck in a processing state (e.g. `extracting`, `anonymizing`) with no pending or running tasks are detected at app startup by `recoverOrphanedSessions()`. These sessions are marked with status `error` and the message "Verarbeitung wurde unerwartet abgebrochen."

## Duplicate Detection

The current implementation does not perform explicit duplicate detection based on file content or path. Each import creates a new session with a unique ID and a fresh copy of the PDF. Importing the same file twice results in two independent sessions.

## PDF Processing Pipeline

The `TaskQueueService` defines the PDF pipeline as three sequential tasks: `extraction`, `ocr`, `anonymization`. Each task runs to completion before the next begins.

### Stage 1: Text Extraction (`PDFExtractionExecutor`)

Uses `pdfjs-dist` (legacy build for Node.js compatibility) with `standardFontDataUrl` configured for correct font rendering. For each page:

1. Extracts text content via `page.getTextContent()`.
2. Joins the text items via `joinTextItems` (`src/main/utils/pdf-text-join.ts`), normalizes whitespace. Items are **not** words: some generators (mirrored text space with negative font size + TJ kerning) yield one item per glyph, so joining with `' '` produced `"H a n s"` and flair tagged the single letters as PERSON. pdfjs already emits word spaces as items and marks line ends with `hasEOL`, so items are concatenated directly; a space is inserted only at `hasEOL` or where the geometry breaks (backward jump > 0.5 em, e.g. table cells; forward gap > 0.102 em; baseline shift > 0.25 em, e.g. superscripts — so "Müller¹" doesn't become an unmatchable "Müller1").
3. Classifies the page as `text` (extracted text longer than 50 characters) or `scanned` (50 characters or fewer).

The extraction result (per-page text, content type, and PDF metadata like title/author) is saved to `~/.therascript/extracted/<sessionId>.json`.

**Optimization**: If all pages are classified as `text` (no scanned pages), the transcript is built immediately and the OCR stage will skip.

**Empty PDFs:** Documents with zero pages raise: "Das PDF-Dokument ist leer (0 Seiten)."

### Stage 2: Vision OCR (`VisionOCRService`)

Runs only on pages classified as `scanned` in stage 1. If there are no scanned pages, the executor returns immediately (progress jumps to 100%).

For each scanned page:

1. Invokes the `vision-ocr` Swift CLI binary (built by `scripts/setup-vision-ocr.sh`) as a subprocess via `nice -n 10` (low CPU priority).
2. Passes `--pdf <path> --page <number>` arguments.
3. Parses JSON output containing `text`, `confidence`, `language`, and `pageNumber`.
4. Updates the extraction data with the OCR text for that page.
5. Each page has a 120-second timeout (`OCR_PAGE_TIMEOUT_MS` in `src/main/ml/ocr-limits.ts`); on timeout, the process is killed and the task fails («OCR für Seite N abgebrochen: Timeout nach 120s»). The limit covers the cold start of Apple Vision: on macOS 27 the first call without a Vision cache takes 25–35 s (the neural-engine models are compiled into `~/Library/Caches/vision-ocr/com.apple.e5rt.e5bundlecache/<OS build>/` of the user account), every later call ~0.25 s. The cache can be gone again after a longer pause or an OS update, so the slow first page is not a one-off. Up to v0.11.0 the limit was 30 s and the first scanned page could fail.

After all scanned pages are processed, the combined transcript (text extraction + OCR results) is built and stored.

### Stage 3: Anonymization

The same NER anonymization pipeline used for audio sessions runs on the PDF transcript. This uses flair NER + regex patterns + blocklist (Sperrliste) to detect and replace personal data with numbered placeholders (e.g. `[PERSON 1]`, `[ORT 1]`). The result is a TipTap document opened in the Review Editor.

## Password-Protected PDFs

Not supported. When `pdfjs-dist` encounters an encrypted/password-protected PDF, the error message is detected (checking for "password" or "encrypted" in the error string) and a clear German-language error is thrown: "Passwortgeschutzte PDFs werden nicht unterstutzt."

## Document Date (#205)

A PDF document carries exactly one document date (OOS 6), which places it in the timeline of every patient dossier it is assigned to (`sessions.document_date`, ISO day). As long as the user has not set one, the local day of the import counts; cards, the timeline and the Review Editor header then show «08.11.2026 · Importdatum» (AK 19/20). Clicking the date opens «Dokumentdatum festlegen» (`DocumentDateDialog`): input `TT.MM.JJJJ`, only a complete, valid calendar day from 1900 on and not after today is accepted (AK 21, checked in the renderer and again in the main process). A set date can be changed but not reset to the import date (OOS 3). Therascript does not read or suggest a date from the PDF (OOS 5). Setting the date changes neither text, pseudonymization, title nor summary, and neither the order nor the groups of the session list. Channel: `session:setDocumentDate`.

## PDF Session vs. Audio Session

| Aspect | Audio Session | PDF Session |
|---|---|---|
| Type field | `'audio'` | `'pdf'` |
| Source file location | `~/.therascript/audio/` | `~/.therascript/pdf/` |
| Pipeline steps | transcription, diarization, alignment, anonymization | extraction, ocr, anonymization |
| Session title | Date/time of recording | PDF filename (or date/time fallback) |
| Place in a dossier timeline (#205) | Local day of the recording | Document date, else local day of the import |
| Speaker labels | Yes (from diarization) | No |
| Timestamps | Yes (from ASR) | No |

## Progress Reporting

Each pipeline stage reports progress to the UI through the same mechanism used by audio processing:

1. The executor calls `onProgress(value)` with a float between 0 and 1.
2. `TaskQueueService` persists the progress in the database and sends a `task:progress` IPC event to the renderer with `{ sessionId, taskType, progress }`.
3. The renderer receives progress updates via the `useTaskProgress` hook, which updates the `SessionCard` display.

Progress distribution by stage:

| Stage | Progress Range | Granularity |
|---|---|---|
| Extraction | 0.05 -- 1.0 | Per page (`0.1 + (page/total) * 0.85`) |
| OCR | 0.05 -- 0.95 | Per scanned page |
| Anonymization | Reported by NER executor | Per pipeline phase |

## Session Status Transitions (PDF)

```
extracting -> anonymizing -> review
```

The `extraction` and `ocr` task completions both map to session status `anonymizing` (via `TASK_TO_SESSION_STATUS`). The `anonymization` task completion transitions the session to `review`, at which point the user can open the Review Editor to inspect and adjust the anonymized document.

## Key Source Files

| File | Role |
|---|---|
| `src/main/ipc/pdf-handlers.ts` | IPC handlers for import and file dialog |
| `src/main/services/PDFExtractionExecutor.ts` | Stage 1: pdfjs-dist text extraction |
| `src/main/ml/VisionOCRService.ts` | Stage 2: Apple Vision OCR for scanned pages |
| `src/main/services/TaskQueueService.ts` | Pipeline definition and task orchestration |
| `src/renderer/src/components/SessionDashboard.tsx` | Drag-and-drop UI |
| `src/renderer/src/contexts/WorkspaceActionsContext.tsx` | `importPdfs` for button, sidebar icon and drag-and-drop |
