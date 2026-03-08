# PDF Import

## Overview

Therascript can anonymize existing PDF documents (e.g. reports, referrals, discharge letters). Users import PDFs via drag-and-drop onto the session dashboard or through a file picker button. The original file is never modified -- a copy is stored in `~/.therascript/pdf/` and processed through a three-stage pipeline: text extraction, optional OCR for scanned pages, and NER-based anonymization.

## Import Methods

### Drag-and-Drop

The `SessionDashboard` component registers drag-and-drop handlers on its root container. When the user drags files over the dashboard, a visual overlay appears ("PDF hier ablegen" with a dashed border and highlighted background). On drop, the component filters for `.pdf` files, resolves native file paths via `webUtils.getPathForFile()`, and calls `window.api.import.pdf(pdfPaths)`. Non-PDF files in the drop are silently ignored.

### File Picker Button

The header bar contains an import button that triggers `handleImportPDF()` in `App.tsx`. This calls `window.api.import.showPDFDialog()`, which opens a native macOS file dialog (`dialog.showOpenDialog`) configured for multi-selection with a `.pdf` file filter. The dialog title reads "PDF-Dokumente zum Anonymisieren auswahlen". If the user cancels, an empty array is returned and no session is created.

Both methods set an `isImporting` flag that prevents concurrent imports. The flag is cleared in a `finally` block so it resets even if the import fails.

## File Handling and Session Creation

For each selected file, the `import:pdf` IPC handler in `pdf-handlers.ts` performs these steps:

1. **Validation** -- Checks that the file exists on disk and has a `.pdf` extension. Throws a German-language error if either check fails.
2. **Session creation** -- Calls `SessionService.createSession(title, 'pdf')`, which inserts a new session with status `extracting` (audio sessions start as `recording`). The session title is derived from the PDF filename; if the name is empty or literally "document", a timestamp-based fallback is used (`PDF DD.MM.YYYY HH:MM`).
3. **File copy** -- Copies the source file to `~/.therascript/pdf/<sessionId>.pdf` using `copyFileSync`. The original file is never moved or modified.
4. **Path storage** -- Updates the session record with the `pdfPath` pointing to the copied file.
5. **Pipeline enqueue** -- Calls `taskQueue.enqueuePipeline(sessionId, 'pdf')` to schedule the three processing tasks.
6. **Session list refresh** -- After all files are imported, the renderer refreshes the session list.

### Copy Failure Rollback

If `copyFileSync` fails (e.g. source is on an ejected volume, permission denied, disk full), the handler rolls back immediately:

- Deletes the just-created session via `sessionService.deleteSession(session.id)`.
- Attempts to remove any partial file at the target path (`unlinkSync`, errors silently ignored).
- Throws an error with the message: "PDF konnte nicht kopiert werden. Bitte stellen Sie sicher, dass die Datei lokal verfugbar ist." followed by the filename and system error.

## Duplicate Detection

The current implementation does not perform explicit duplicate detection based on file content or path. Each import creates a new session with a unique ID and a fresh copy of the PDF. Importing the same file twice results in two independent sessions.

## PDF Processing Pipeline

The `TaskQueueService` defines the PDF pipeline as three sequential tasks: `extraction`, `ocr`, `anonymization`. Each task runs to completion before the next begins.

### Stage 1: Text Extraction (`PDFExtractionExecutor`)

Uses `pdfjs-dist` (legacy build for Node.js compatibility) with `standardFontDataUrl` configured for correct font rendering. For each page:

1. Extracts text content via `page.getTextContent()`.
2. Joins all text items, normalizes whitespace.
3. Classifies the page as `text` (extracted text longer than 50 characters) or `scanned` (50 characters or fewer).

The extraction result (per-page text, content type, and PDF metadata like title/author) is saved to `~/.therascript/extracted/<sessionId>.json`.

**Optimization**: If all pages are classified as `text` (no scanned pages), the transcript is built immediately and the OCR stage will skip.

### Stage 2: Vision OCR (`VisionOCRService`)

Runs only on pages classified as `scanned` in stage 1. If there are no scanned pages, the executor returns immediately (progress jumps to 100%).

For each scanned page:

1. Invokes the `vision-ocr` Swift CLI binary (built by `scripts/setup-vision-ocr.sh`) as a subprocess via `nice -n 10` (low CPU priority).
2. Passes `--pdf <path> --page <number>` arguments.
3. Parses JSON output containing `text`, `confidence`, `language`, and `pageNumber`.
4. Updates the extraction data with the OCR text for that page.
5. Each page has a 30-second timeout (`PAGE_TIMEOUT_MS`); on timeout, the process is killed and the task fails.

After all scanned pages are processed, the combined transcript (text extraction + OCR results) is built and stored.

### Stage 3: Anonymization

The same NER anonymization pipeline used for audio sessions runs on the PDF transcript. This uses flair NER + regex patterns + blocklist (Sperrliste) to detect and replace personal data with numbered placeholders (e.g. `[PERSON 1]`, `[ORT 1]`). The result is a TipTap document opened in the Review Editor.

## Password-Protected PDFs

Not supported. When `pdfjs-dist` encounters an encrypted/password-protected PDF, the error message is detected (checking for "password" or "encrypted" in the error string) and a clear German-language error is thrown: "Passwortgeschutzte PDFs werden nicht unterstutzt."

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
| `src/renderer/src/App.tsx` | File picker button handler |
