# ML Pipeline

Therascript processes audio recordings and PDF documents through a strictly sequential ML pipeline. Only one model is loaded into RAM at a time — a hard constraint driven by the 8 GB minimum RAM budget.

## RAM Budget

| Phase | Model / Tool | Peak RAM |
|---|---|---|
| ASR (transcription) | Whisper Large V3 Turbo Q5_0 | ~1.8 GB |
| Diarization | pyannote speaker-diarization-community-1 | ~0.2 GB |
| Alignment | In-process (no model) | < 50 MB |
| NER / Anonymization | flair/ner-german-large | ~3.5 GB on 8-GB Macs, ~4.8 GB above (process incl. GPU memory, fp16 on MPS) |
| OCR (PDF only) | Apple Vision (Swift subprocess) | < 100 MB |
| Search (outside the pipeline) | EmbeddingGemma 2 text encoder (`search_service.py`) | ~1.5 GiB loaded, ~2.1 GiB while indexing in short runs (≤ 148 sections; process incl. GPU memory, bf16 on MPS) |

Models are never loaded simultaneously. Each subprocess exits before the next task begins.

## Model Specifications

| Model | File on disk | Quantization | Benchmark | Language |
|---|---|---|---|---|
| Whisper Large V3 Turbo | `~/.therascript/models/asr/ggml-large-v3-turbo-q5_0.bin` | Q5_0 (GGML), ~0.6 GB | WER see ADR-003 | German (de) |
| pyannote speaker-diarization-community-1 | `~/.therascript/models/diarization/` | none (fp32) | DER 8.3% on German | Language-agnostic |
| flair/ner-german-large | `~/.therascript/models/ner/` | fp16 on disk (artifact v3) and at inference on MPS; fp32 only on the CPU path | F1 ~92% | German |
| Apple Vision OCR | system framework (no download) | n/a | n/a | Multilingual |

All model directories are created at startup by `initDatabase()`. Total download size on first launch is approximately 1.7 GB (Whisper 0.6 GB + pyannote 0.06 GB + flair NER 1.0 GB; source of truth: `src/shared/model-catalog.ts`).

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
- `diarize.py` loads the WAV once, downmixes it to mono and resamples it to the embedding model's rate (16 kHz), then passes it to pyannote as an in-memory `{"waveform", "sample_rate"}` dict. Passing the file path instead would make pyannote read and resample every embedding chunk (~3000 per 50 min) from disk through the torchcodec shim. Loading and resampling run in 60-s blocks: resampling the whole file in one call makes torchaudio's `conv1d` unfold it (im2col) — measured 19 GiB extra for a 2-h recording versus 0.6 GiB blockwise.
- Timeout: 4x estimated audio duration, minimum 10 minutes (covers the model load, which does not scale with input length).
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
         Model: flair/ner-german-large, ~3.5 GB peak RAM (8-GB Macs)
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
         Model: flair/ner-german-large, ~3.5 GB peak RAM (8-GB Macs)
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
| NER | Fixed 900 s (15 minutes) |
| OCR (per page) | Fixed 30 s per page |

On timeout, `SIGTERM` is sent to the child process and the executor rejects with a timeout error, triggering the same failure path as a non-zero exit code.

### Startup Recovery

At app startup, `TaskQueueService.recoverStuckTasks()` resets any tasks left in `running` state (from a previous crash) back to `pending`. `recoverOrphanedSessions()` finds sessions stuck in a processing status (`transcribing`, `diarizing`, `extracting`, `anonymizing`) that have no pending or running tasks, and marks them as `error` with the message "Verarbeitung wurde unerwartet abgebrochen."

### Missing Binary or Model

Each executor checks for the presence of its binary and model file before spawning. If either is missing, it throws immediately with a German-language error directing the user to the relevant setup script. This produces an `error` session status before any subprocess is started.

---

## Search Service (`search_service.py`)

**Source:** `python_sidecar/search_service.py` (Epic #192, ADR-010). Not a pipeline step: it embeds search queries and transcript sections for the semantic search. The Node side (worker, index, ranking) is built in later PRs of the epic.

- **Model:** text encoder of `google/embeddinggemma-2` (Apache-2.0), re-implemented in pure torch after `modeling_embedding_gemma2.py` from transformers — sentence-transformers needs transformers ≥ 5, flair needs < 5 (ADR-010). Artifact `embeddinggemma-2-text-v1` (`config.json`, `model.safetensors` bf16, `tokenizer.json`, `LICENSE`, `READY`), produced by `scripts/export-search-model.py`.
- **Pipeline:** prompt + text → tokenizer (truncated to `max_tokens` incl. `<bos>`/`<eos>`) → encoder → mean pooling over the mask → L2 normalization → 768 float32 values. Prompts, `max_tokens` and `pad_multiple` are arguments (they will come from the catalog). Before tokenizing, each text is clipped to `max_tokens × 32` characters (no Gemma token covers more than 31 characters, so the result is unchanged) and unpaired surrogates become U+FFFD.
- **Precision:** bf16 on MPS, never fp16; fp32 on the CPU. After an MPS OOM the token budget is halved relative to the failed batch (floor 128, kept for the process lifetime); a single text that still fails moves the model to the CPU (`.to('cpu')`, then `.float()`). If that move itself fails, the service exits with code 3.
- **Memory:** batches sorted by length, padded to multiples of 128 tokens, at most 2 texts and 2048 padded token slots per batch, `empty_cache` after every batch. Without the 128 grid indexing peaked at 3.9 GiB `phys_footprint`. Measured on short runs (M5 Pro): ~1.5 GiB after loading, ~2.1 GiB peak while indexing 40–148 sections (Ø ~372 tokens). Batch 2 is as fast as batch 4 (~58 ms per section) with a lower peak.
- **Autorelease pool:** torch-MPS creates autoreleased Objective-C objects per kernel launch, and a Python process has no run loop that drains them: without a pool `phys_footprint` grew by ~100 KiB per forward pass, linearly and outside the torch allocator (`driver_allocated_memory()`, tracemalloc, `gc.collect()` and `synchronize()` showed or changed nothing). Every forward pass therefore runs inside `objc_autoreleasePoolPush/Pop` (ctypes). Measured with `selftest --soak 2000`: 827 bytes per pass instead of ~100 KiB.
- **Process:** one long-lived process per use (`serve --model-dir <dir>`), JSON Lines with request IDs. Before the ready line one warm-up pass compiles the MPS shaders (first request 48 instead of ~200 ms; ready ~0.25 s later).

| Direction | Line |
|---|---|
| stdout, first line | `{"ready":true,"device":"mps","dtype":"bfloat16","load_ms":…,"dim":768,"phys_footprint_bytes":…}` |
| `ping` | `{"id":1,"op":"ping"}` → `{"id":1,"ok":true,"device":…,"dtype":…,"phys_footprint_bytes":…}` |
| `embed_query` | `{"id":2,"op":"embed_query","text":"…"}` → `{"id":2,"dim":768,"vector":"<base64>","phys_footprint_bytes":…}` |
| `embed_documents` | `{"id":3,"op":"embed_documents","texts":[…]}` → `{"id":3,"dim":768,"vectors":["<base64>",…],"phys_footprint_bytes":…}` (max. 256 texts) |
| `shutdown` | `{"id":4,"op":"shutdown"}` → `{"id":4,"ok":true,"phys_footprint_bytes":…}`, exit 0 |
| error (process keeps running) | `{"id":…,"error":{"code":"bad_json\|bad_request\|unknown_op\|too_large\|internal","message":"…"}}` |

  Vectors are float32 little-endian, base64. stdout carries **only** protocol lines: fd 1 is redirected to stderr at start-up, everything else goes through `_emit` to stderr, including the contract line `Gewichte: torch.bfloat16 auf mps`. Exit codes: 0 (stdin EOF, `shutdown`, parent gone), 1 (bad arguments), 2 (model not loadable), 3 (fatal, e.g. failed move to the CPU).

  Rules for the caller (the worker in a later PR):
  - **Restart by memory:** every response carries `phys_footprint_bytes`. The caller restarts the process once it exceeds a threshold (e.g. 2.5 GiB) or after N forward passes, whichever comes first. The autorelease pool removes the measured growth, but a residual of ~1 KiB per pass remains, and future torch versions may behave differently.
  - **`id: null`:** `bad_json` and `too_large` answer with `id: null`, because the line could not be read. The caller assigns them by order (requests are answered strictly in order).
  - **EOF:** after stdin EOF the process exits within 2 s, also mid-batch; a half-written last stdout line is possible and must be discarded.
  - **stderr:** the caller must drain stderr continuously, otherwise a full pipe blocks the service.
- **Lifetime:** a watcher thread exits when the parent process disappears. No `[HEARTBEAT]`: there is no ProcessWatchdog, the Node side sets a timeout per request.
- **Safeguard:** `selftest --model-dir <dir> --golden tests/fixtures/search-golden/golden.json [--bench N] [--soak N]` compares against golden vectors from sentence-transformers (fp32, CPU, original model), with the threshold of the device each vector was computed on: cosine ≥ 0.999 in bf16 on MPS, ≥ 0.9999995 in fp32 on the CPU (`THERASCRIPT_SEARCH_DEVICE=cpu`). Only the CPU run catches off-by-one errors in the encoder: sliding window 511/513 and truncation to 1023 stayed ≥ 0.99992 on MPS but fell to 0.99993–0.999998 on the CPU. Smoke checks `search script` (always: `--help`, exit 2 without a model), `search load`, `search eof`, `search parity`, `search parity cpu`, `search memory` in `scripts/smoke-packaged.sh --search-model-dir <dir>`.

---

## Python Sidecar Resolution

**Source:** `src/main/ml/resolve-python.ts`

Both `PyannoteSidecar` and `AnonymizationService` call `resolvePythonSidecar(scriptName)` to locate the Python binary and script. Resolution order:

1. **Production** (`app.isPackaged`): standalone relocatable Python at `resources/ml_sidecar/standalone/bin/python3`, script at `resources/ml_sidecar/{scriptName}`.
2. **Dev — venv**: `python_sidecar/venv/bin/python3` + `python_sidecar/{scriptName}`.
3. **Dev — standalone build**: `python_sidecar/standalone/bin/python3` + `python_sidecar/{scriptName}`.
4. Throws with setup instructions if none of the above exist.

The standalone Python is built via `uv` (not PyInstaller) and all `.dylib`/`.so` files are ad-hoc codesigned. The `torchcodec_shim.py` soundfile fallback is loaded automatically via `sitecustomize.py` in the standalone environment.
