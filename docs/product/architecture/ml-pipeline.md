# ML Pipeline

Therascript processes audio recordings and PDF documents through a strictly sequential ML pipeline. Only one model is loaded into RAM at a time — a hard constraint driven by the 8 GB minimum RAM budget.

## RAM Budget

| Phase | Model / Tool | Peak RAM |
|---|---|---|
| ASR (transcription) | Whisper Large V3 Turbo Q5_0 | ~1.8 GB |
| Diarization | pyannote speaker-diarization-community-1 | ~0.2 GB |
| Alignment | In-process (no model) | < 50 MB |
| NER / Anonymization | flair/ner-german-large | ~5.2 GB |
| OCR (PDF only) | Apple Vision (Swift subprocess) | < 100 MB |

Models are never loaded simultaneously. Each subprocess exits before the next task begins.

## Model Specifications

| Model | File on disk | Quantization | Benchmark | Language |
|---|---|---|---|---|
| Whisper Large V3 Turbo | `~/.therascript/models/asr/ggml-large-v3-turbo-q5_0.bin` | Q5_0 (GGML) | ~1.7 GB | German (de) |
| pyannote speaker-diarization-community-1 | `~/.therascript/models/diarization/` | none (fp32) | DER 8.3% on German | Language-agnostic |
| flair/ner-german-large | `~/.therascript/models/ner/` | none (fp32) | F1 ~92% | German |
| Apple Vision OCR | system framework (no download) | n/a | n/a | Multilingual |

All model directories are created at startup by `initDatabase()`. Total download size on first launch is approximately 4.1 GB.

---

## Audio Pipeline

Processing begins after the recording stops. Four tasks are enqueued in order:

```
transcription → diarization → alignment → anonymization
```

### Step 1 — Transcription (`WhisperService`)

**Source:** `src/main/ml/WhisperService.ts`

- Spawns `whisper-cli` (whisper.cpp binary) as a subprocess via `nice -n 10`.
- Flags: `-l de` (German), `-ojf` (JSON output with word-level timestamps), `-pp` (progress reporting), `-t <cpu_count>` (capped at 8 threads).
- Output is written to `{audioPath}.json` by whisper.cpp; the file is read after the process exits, then deleted.
- Timeout: 4x estimated audio duration, minimum 60 seconds.
- Token post-processing in `WhisperService.processOutput()`: special tokens are filtered, sub-tokens are merged, filler words (`filler-removal.ts`) are removed, and words are grouped back into segments.
- Result: a `TranscriptData` JSON file saved to `~/.therascript/transcripts/{sessionId}.json`.

Session status during this step: `transcribing`.

### Step 2 — Diarization (`PyannoteSidecar`)

**Source:** `src/main/ml/PyannoteSidecar.ts`

- Spawns the Python sidecar script `diarize.py` via `resolvePythonSidecar()`.
- Arguments: `--audio`, `--model-dir`, `--min-speakers 1`, `--max-speakers 4`.
- `OMP_NUM_THREADS=4` and `MKL_NUM_THREADS=4` are set to prevent PyTorch from saturating all CPU cores.
- Timeout: 4x estimated audio duration, minimum 2 minutes.
- Output: RTTM-format text on stdout, parsed by `parseRTTM()`.
- Post-processing: segments shorter than 0.5 seconds are discarded as segmentation noise; segments are sorted by start time.
- Result: a `DiarizationData` JSON file saved to `~/.therascript/diarizations/{sessionId}.json`.

Session status during this step: `diarizing`.

### Step 3 — Alignment (`AlignmentService`)

**Source:** `src/main/ml/AlignmentService.ts`

This step runs entirely in-process — no subprocess, no ML model. It merges the Whisper word-timestamps with the pyannote speaker segments.

- Loads the `TranscriptData` and `DiarizationData` JSON files produced by steps 1–2.
- Each word is assigned to the speaker segment with the greatest temporal overlap (`findBestOverlapSegment`). Words that fall in gaps between speaker segments are assigned to the nearest segment boundary.
- Sentence-boundary correction (`correctSentenceBoundaries`): when a speaker change occurs mid-sentence, the boundary is snapped back to the nearest `.!?` within 5 words, provided the new speaker holds for at least 2 consecutive words. This compensates for the 0.5–1.5 s offset typical of pyannote segment boundaries.
- Raw pyannote labels (`SPEAKER_00`, `SPEAKER_01`, ...) are remapped to ordered letters (`Person A`, `Person B`, ...) by order of first appearance.
- For single-speaker transcripts, speaker labels are stripped entirely.
- The updated `TranscriptData` (with `speaker` fields on every word and segment) overwrites the transcript file in place.

Session status during this step: `diarizing` (alignment is part of the diarization phase from the UI perspective).

### Step 4 — Anonymization (`AnonymizationService`)

**Source:** `src/main/ml/AnonymizationService.ts`

Three entity sources are combined, then a TipTap document is built:

1. **flair NER (Python sidecar):** Spawns `ner_service.py` with `--transcript` and `--model-dir`. Returns a JSON array of named entities. Covers 7 entity types: `PERSON`, `ORT`, `DATUM`, `KONTAKT`, `BERUF`, `DIAGNOSE`, `MEDIKAMENT`. `ORG` entities from flair are discarded.
2. **Regex engine (`regex-patterns.ts`):** Runs 10 pattern groups over every transcript segment in the main process. Catches Swiss-specific PII: AHV numbers, phone numbers, email addresses, postal codes, dates, insurance numbers, case numbers, street addresses.
3. **Blocklist:** Loaded from SQLite. Entries are matched with bidirectional Umlaut normalization and longest-match-first replacement.

Merge priority: NER > Blocklist > Regex. Overlapping spans are resolved by keeping the earlier/longer match.

After merging, coreference resolution (`coreference-resolver.ts`) links `PERSON` pronoun references to their canonical entity. An `EntityMap` is built assigning stable IDs (`PERSON-1`, `ORT-1`, etc.) to each unique entity.

`buildTipTapDocument()` converts the aligned segments into a ProseMirror document:
- Multi-speaker: each paragraph starts with a `timestamp` node and a `speakerLabel` node.
- Entity spans become `placeholderChip` inline nodes with `entityId`, `type`, `number`, and the original text preserved.

Result: a TipTap JSON file saved to `~/.therascript/anonymized/{sessionId}.json`.

Session status after completion: `review`.

### Audio Pipeline — Summary

```
[WAV file]
    |
    v
[Step 1] WhisperService (whisper.cpp subprocess)
         Language: de, Model: ggml-large-v3-turbo-q5_0, ~1.8 GB RAM
         Output: TranscriptData (words + timestamps)
    |
    v
[Step 2] PyannoteSidecar (Python subprocess: diarize.py)
         Model: pyannote-community-1, ~0.2 GB RAM
         Output: DiarizationData (speaker segments, RTTM)
    |
    v
[Step 3] AlignmentService (in-process, no model)
         Merges word timestamps with speaker segments
         Output: TranscriptData updated with speaker labels
    |
    v
[Step 4] AnonymizationService (Python subprocess: ner_service.py + in-process)
         Model: flair/ner-german-large, ~5.2 GB peak RAM
         Sources: flair NER + regex engine + blocklist
         Output: TipTap JSON document with placeholderChip nodes
    |
    v
[Review Editor] — session status: review
```

---

## PDF Pipeline

PDF sessions enqueue three tasks:

```
extraction → ocr → anonymization
```

### Step 1 — Text Extraction (`extraction` task)

Uses `pdfjs-dist` in the main process to extract text page by page. Each page is classified as `text` (machine-readable) or `scanned` (image-only, below a character-count threshold). The result is an `ExtractionResult` JSON file stored at `~/.therascript/extracted/{sessionId}.json`.

Session status during this step: `extracting`.

### Step 2 — OCR (`VisionOCRService`)

**Source:** `src/main/ml/VisionOCRService.ts`

- Skipped entirely if no pages are classified as `scanned`.
- For each scanned page, spawns the `vision-ocr` Swift CLI helper (`resources/bin/vision-ocr`) via `nice -n 10`.
- Arguments: `--pdf {path}`, `--page {number}`.
- Per-page timeout: 30 seconds.
- Output: JSON with `text`, `confidence`, `language`, `pageNumber`. If JSON parsing fails, raw stdout is used as the page text.
- OCR results are merged back into the `ExtractionResult` pages array, then `buildPDFTranscript()` writes a unified `TranscriptData` file.

Session status during this step: `extracting`.

### Step 3 — Anonymization

Identical to audio pipeline step 4. The same `AnonymizationService` processes the PDF transcript through flair NER, regex engine, and blocklist, producing a TipTap JSON document.

Session status after completion: `review`.

### PDF Pipeline — Summary

```
[PDF file]
    |
    v
[Step 1] pdfjs-dist (in-process)
         Text extraction per page, classify: text | scanned
         Output: ExtractionResult JSON
    |
    v
[Step 2] VisionOCRService (Swift CLI subprocess: vision-ocr)
         Apple Vision framework, system OCR
         Skipped if no scanned pages
         Output: ExtractionResult with OCR text merged → TranscriptData
    |
    v
[Step 3] AnonymizationService (Python subprocess: ner_service.py + in-process)
         Model: flair/ner-german-large, ~5.2 GB peak RAM
         Output: TipTap JSON document with placeholderChip nodes
    |
    v
[Review Editor] — session status: review
```

---

## Task Queue

**Source:** `src/main/services/TaskQueueService.ts`

`TaskQueueService` is a singleton that enforces sequential execution across all sessions. At most one task runs at a time, regardless of how many sessions are queued.

### Task States

| State | Description |
|---|---|
| `pending` | Created, waiting to run |
| `running` | Currently executing |
| `completed` | Finished successfully |
| `failed` | Executor threw an error |

### Pipeline Definitions

```typescript
const AUDIO_PIPELINE: TaskType[] = ['transcription', 'diarization', 'alignment', 'anonymization']
const PDF_PIPELINE: TaskType[] = ['extraction', 'ocr', 'anonymization']
```

Tasks are written to SQLite on creation. `enqueuePipeline()` inserts all tasks for a session, then calls `scheduleNext()` if the queue is not already processing.

### Session Status Progression

The session status displayed in the UI is updated after each task completes. The mapping from completed task to next session status:

| Completed task | Session status while next task runs |
|---|---|
| `transcription` | `diarizing` |
| `diarization` | `diarizing` (alignment follows) |
| `alignment` | `anonymizing` |
| `extraction` | `extracting` (OCR follows) |
| `ocr` | `anonymizing` |
| `anonymization` | `review` (terminal) |

### Progress Reporting

Each executor calls `onProgress(0.0–1.0)` as it runs. `TaskQueueService` writes the progress value to SQLite and emits a `task:progress` IPC event to the renderer. On completion, a `task:completed` event is emitted. On failure, a `task:error` event is emitted.

---

## Error Handling

### Subprocess Failure

When any subprocess exits with a non-zero code, the executor collects error lines from stderr (lines containing `error`, `Error`, or `failed`) and throws with a German-language error string. `TaskQueueService.handleTaskFailure()` then:

1. Marks the task as `failed` in SQLite with the error message.
2. Sets the session status to `error` with the error message.
3. Emits `task:error` to the renderer, which displays the error in the session card.

The queue does not continue to the next task for that session once any task fails.

### Timeouts

| Task | Timeout strategy |
|---|---|
| Transcription | 4x estimated audio duration, min 60 s |
| Diarization | 4x estimated audio duration, min 120 s |
| NER | Fixed 300 s (5 minutes) |
| OCR (per page) | Fixed 30 s per page |

On timeout, `SIGTERM` is sent to the child process and the executor rejects with a timeout error, triggering the same failure path as a non-zero exit code.

### Startup Recovery

At app startup, `TaskQueueService.recoverStuckTasks()` resets any tasks left in `running` state (from a previous crash) back to `pending`. `recoverOrphanedSessions()` finds sessions stuck in a processing status (`transcribing`, `diarizing`, `extracting`, `anonymizing`) that have no pending or running tasks, and marks them as `error` with the message "Verarbeitung wurde unerwartet abgebrochen."

### Missing Binary or Model

Each executor checks for the presence of its binary and model file before spawning. If either is missing, it throws immediately with a German-language error directing the user to the relevant setup script. This produces an `error` session status before any subprocess is started.

---

## Python Sidecar Resolution

**Source:** `src/main/ml/resolve-python.ts`

Both `PyannoteSidecar` and `AnonymizationService` call `resolvePythonSidecar(scriptName)` to locate the Python binary and script. Resolution order:

1. **Production** (`app.isPackaged`): standalone relocatable Python at `resources/ml_sidecar/standalone/bin/python3`, script at `resources/ml_sidecar/{scriptName}`.
2. **Dev — venv**: `python_sidecar/venv/bin/python3` + `python_sidecar/{scriptName}`.
3. **Dev — standalone build**: `python_sidecar/standalone/bin/python3` + `python_sidecar/{scriptName}`.
4. Throws with setup instructions if none of the above exist.

The standalone Python is built via `uv` (not PyInstaller) and all `.dylib`/`.so` files are ad-hoc codesigned. The `torchcodec_shim.py` soundfile fallback is loaded automatically via `sitecustomize.py` in the standalone environment.
