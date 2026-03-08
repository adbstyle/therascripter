# PDF Import

## Overview

Therascript supports importing PDF documents for anonymization. Users can bring in existing therapy reports, referral letters, or other documents containing personal data. The imported PDF is copied into the app's local data directory, a session is created, and the document passes through a three-stage pipeline: text extraction, OCR (if needed), and NER-based anonymization. The original file is never modified.

## Import Methods

### Drag-and-Drop

Users can drag one or more PDF files directly onto the session dashboard (`SessionDashboard`). The component listens for `dragOver`, `dragLeave`, and `drop` events across the entire dashboard area, including the empty state. During a drag-over, a visual overlay appears with the prompt "PDF hier ablegen". On drop, the renderer extracts native file paths via `webUtils.getPathForFile()` (Electron preload bridge), filters for `.pdf` extensions, and sends them to the main process through the `import:pdf` IPC channel.

### File Picker Button

The "PDF importieren" button in the app header triggers a native macOS open-file dialog (`dialog.showOpenDialog`) with multi-selection enabled and a PDF file-type filter. The dialog is invoked through the `import:showPDFDialog` IPC channel. Selected file paths are then passed to the same `import:pdf` handler used by drag-and-drop.

Both methods are guarded by an `isImporting` flag that prevents concurrent imports.

## File Handling

When the main process receives file paths via `import:pdf`:

1. **Validation** -- Each path is checked for existence (`existsSync`) and `.pdf` extension. Non-PDF files and missing files raise an error immediately.
2. **Session creation** -- A new session is created with `type: 'pdf'` and a title derived from the filename (via `generatePDFTitle`). If the filename is empty or "document", a fallback title with the current date/time is used (e.g. "PDF 08.03.2026 14:30").
3. **File copy** -- The PDF is copied to `~/.therascript/pdf/<sessionId>.pdf` using `copyFileSync`. The session UUID ensures uniqueness -- the same source file can be imported multiple times, each producing an independent session.
4. **Session update** -- The `pdfPath` field on the session record is set to the copied file's location.
5. **Pipeline enqueue** -- The PDF processing pipeline (`extraction` -> `ocr` -> `anonymization`) is enqueued in the task queue.

### Copy Failure Rollback

If the file copy fails (e.g. the source is on a disconnected network share), the handler performs a rollback:

- The newly created session is deleted from the database via `sessionService.deleteSession()`.
- Any partial file at the target path is removed (`unlinkSync`).
- An error is thrown with the German message: "PDF konnte nicht kopiert werden. Bitte stellen Sie sicher, dass die Datei lokal verfügbar ist."

### Orphaned Session Recovery

Sessions that get stuck in a processing state (e.g. `extracting`, `anonymizing`) with no pending or running tasks are detected at app startup by `recoverOrphanedSessions()`. These sessions are marked with status `error` and the message "Verarbeitung wurde unerwartet abgebrochen."

## PDF Processing Pipeline

The task queue runs three sequential steps for PDF sessions, defined as `['extraction', 'ocr', 'anonymization']`.

### Step 1: Text Extraction (`PDFExtractionExecutor`)

Uses `pdfjs-dist` (legacy build for ESM compatibility) to extract text from each page.

- Loads the PDF from the copied file at `~/.therascript/pdf/<sessionId>.pdf`.
- Configures `standardFontDataUrl` pointing to pdfjs-dist's bundled font data for correct text rendering.
- For each page, extracts text content items and joins them into a single string (whitespace-normalized).
- Classifies each page as `'text'` or `'scanned'` based on a 50-character threshold (`TEXT_PAGE_THRESHOLD`). Pages with fewer than 50 characters of extractable text are considered scanned/image-based.
- Saves the extraction result (per-page data + PDF metadata like title and author) as JSON to `~/.therascript/extracted/<sessionId>.json`.
- If all pages are text (no scanned pages), the transcript is built immediately and the session's `transcriptPath` is set. This allows the OCR step to skip quickly.

**Password-protected PDFs:** If pdfjs-dist throws an error containing "password" or "encrypted", a specific German error is raised: "Passwortgeschutzte PDFs werden nicht unterstutzt." Password-protected documents are not supported.

**Empty PDFs:** Documents with zero pages raise: "Das PDF-Dokument ist leer (0 Seiten)."

### Step 2: Vision OCR (`VisionOCRService`)

Runs Apple Vision framework OCR on scanned pages only.

- Loads the extraction JSON produced by step 1.
- Filters for pages with `contentType: 'scanned'`.
- If there are no scanned pages, the step completes immediately (transcript was already built during extraction).
- For each scanned page, spawns the `vision-ocr` Swift CLI helper (located at `resources/bin/vision-ocr`) as a subprocess via `nice -n 10` (low CPU priority).
- The CLI receives `--pdf <path> --page <number>` arguments and returns JSON with the OCR text, confidence, and detected language.
- Each page has a 30-second timeout (`PAGE_TIMEOUT_MS`). If exceeded, the process is killed with SIGTERM.
- After all scanned pages are processed, the extraction data is updated with OCR text and a transcript is built combining text-extracted and OCR'd pages. The `ocrEngine` is recorded as `'apple-vision-ocr'` (vs. `'pdfjs-dist'` for text-only documents).

### Step 3: Anonymization

The same NER anonymization pipeline used for audio transcripts processes the PDF transcript. This step uses flair NER, regex patterns, and the user's blocklist (Sperrliste) to detect and replace personal data with typed placeholders (e.g. `[PERSON 1]`, `[ORT 1]`).

## PDF Session vs. Audio Session

| Aspect | Audio Session | PDF Session |
|---|---|---|
| Type field | `'audio'` | `'pdf'` |
| Source file location | `~/.therascript/audio/` | `~/.therascript/pdf/` |
| Pipeline steps | transcription, diarization, alignment, anonymization | extraction, ocr, anonymization |
| Session title | Date/time of recording | PDF filename (or date/time fallback) |
| Speaker labels | Yes (from diarization) | No |
| Timestamps | Yes (from ASR) | No |

## Progress Reporting

Each pipeline step reports progress to the UI through the task queue's callback mechanism:

1. The executor calls `onProgress(value)` with a float between 0 and 1.
2. `TaskQueueService` persists the progress to the database and sends a `task:progress` IPC event to the renderer with the session ID, task type, and progress value.
3. On completion, a `task:completed` event is sent. On failure, `task:error` carries the error message.

Progress distribution within the extraction step: 5% for PDF loading, then 85% spread linearly across pages, with the final 10% for saving results. The OCR step allocates 5% upfront and 90% across scanned pages.

## Key Source Files

| File | Role |
|---|---|
| `src/main/ipc/pdf-handlers.ts` | IPC handlers for `import:pdf` and `import:showPDFDialog` |
| `src/main/services/PDFExtractionExecutor.ts` | pdfjs-dist text extraction task executor |
| `src/main/ml/VisionOCRService.ts` | Apple Vision OCR task executor for scanned pages |
| `src/renderer/src/components/SessionDashboard.tsx` | Drag-and-drop UI + session list |
| `src/renderer/src/App.tsx` | Header "PDF importieren" button + file picker flow |
| `src/main/services/TaskQueueService.ts` | Pipeline orchestration and progress dispatch |
