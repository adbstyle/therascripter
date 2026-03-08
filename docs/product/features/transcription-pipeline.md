# Transcription Pipeline

## Overview

After a recording is stopped, Therascript runs three sequential ML steps to produce a speaker-attributed transcript: ASR (speech-to-text), diarization (who spoke when), and alignment (merging both). Each step runs as a separate task in the task queue, strictly one at a time to stay within the 8 GB RAM budget.

## Step 1: ASR (Automatic Speech Recognition)

`WhisperService` (`src/main/ml/WhisperService.ts`) invokes `whisper-cli` (whisper.cpp) as a subprocess.

### Model

| Property | Value |
|---|---|
| Model | Whisper Large V3 Turbo |
| Quantization | Q5_0 (GGML) |
| File | `ggml-large-v3-turbo-q5_0.bin` |
| Path | `~/.therascript/models/asr/ggml-large-v3-turbo-q5_0.bin` |
| Acceleration | Metal GPU (Apple Silicon) |

### Binary resolution

- **Production**: `<app resources>/bin/whisper-cli`
- **Development**: `<project root>/resources/bin/whisper-cli`

### Invocation

The subprocess is spawned via `nice -n 10` (QoS priority, NFR-23) with these arguments:

| Flag | Purpose |
|---|---|
| `-m <path>` | Path to the GGML model file |
| `-f <path>` | Input audio file (48 kHz 16-bit mono WAV) |
| `-l de` | Language forced to German |
| `-pp` | Print progress to stderr |
| `-ojf` | Output full JSON (word-level timestamps) to `<audioPath>.json` |
| `-t <n>` | Thread count (`min(8, cpu count)`) |

stdout is deliberately ignored (piped to `/dev/null`). whisper.cpp writes its JSON output to a file (`-ojf`), not stdout -- reading stdout would cause a deadlock when the pipe buffer fills.

### Swiss German handling

The `-l de` flag forces Whisper to interpret all input as German. When processing Swiss-German dialect (Schweizerdeutsch), Whisper normalizes the speech to standard German (Hochdeutsch) in the output text. There is no separate Swiss-German language code -- the `de` language constraint is sufficient because the Whisper Large V3 model has been trained on diverse German-language data including dialect speech.

### Output format

whisper.cpp writes a JSON file with the structure:

```json
{
  "transcription": [
    {
      "timestamps": { "from": "00:00:00,000", "to": "00:00:05,000" },
      "offsets": { "from": 0, "to": 5000 },
      "text": " Guten Tag, bitte nehmen Sie Platz.",
      "tokens": [
        { "text": " Guten", "id": 42, "p": 0.98, "offsets": { "from": 0, "to": 800 } },
        { "text": " Tag", "id": 43, "p": 0.95, "offsets": { "from": 800, "to": 1200 } }
      ]
    }
  ]
}
```

### Post-processing pipeline

After parsing the JSON, the output goes through four processing steps:

1. **Filter special tokens** (`token-processing.ts`) -- Removes whisper internal control tokens matching the pattern `[_..._]` (e.g., `[_BEG_]`, `[_TT_500]`, `[_EOT_]`, `[_SOT_]`, `[_NOSPEECH_]`).
2. **Merge BPE sub-tokens** (`token-processing.ts`) -- Whisper uses BPE tokenization where tokens starting with a space begin a new word and tokens without a leading space continue the previous word. This step reassembles sub-tokens into complete words with correct start/end timestamps (offsets converted from milliseconds to seconds).
3. **Remove filler words** (`filler-removal.ts`) -- Strips hesitation fillers: `äh`, `ähm`, `ah`, `ahm`, `uh`, `uhm`, `hm`, `hmm`, `mhm`, `mh` (and case variants). Per Decision #33, only pure filler sounds are removed; real filler words like "also" or "quasi" are kept.
4. **Rebuild segments** (`filler-removal.ts`) -- Groups the cleaned words into sentence-level segments, splitting on `.`, `!`, or `?` punctuation.

### Saved output

The result is written as a `TranscriptData` JSON file at `~/.therascript/transcripts/<sessionId>.json`:

```typescript
interface TranscriptData {
  words: { text: string; start: number; end: number }[]
  segments: { text: string; start: number; end: number }[]
  metadata: { model: string; language: string; duration: number }
}
```

## Step 2: Diarization (Speaker Identification)

`PyannoteSidecar` (`src/main/ml/PyannoteSidecar.ts`) runs the pyannote.audio pipeline via a Python sidecar process.

### Model

| Property | Value |
|---|---|
| Model | pyannote speaker-diarization-community-1 |
| Path | `~/.therascript/models/diarization/` |

### Python resolution

The sidecar binary is resolved by `resolvePythonSidecar()` (`src/main/ml/resolve-python.ts`) in this order:

1. **Production**: `<app resources>/ml_sidecar/standalone/bin/python3` running `<app resources>/ml_sidecar/diarize.py`
2. **Dev (venv)**: `python_sidecar/venv/bin/python3` running `python_sidecar/diarize.py`
3. **Dev (standalone)**: `python_sidecar/standalone/bin/python3` running `python_sidecar/diarize.py`

### Invocation

Spawned via `nice -n 10` with these arguments:

| Flag | Purpose |
|---|---|
| `--audio <path>` | Input WAV audio file |
| `--model-dir <path>` | Directory containing diarization model files |
| `--min-speakers 1` | Minimum expected speakers |
| `--max-speakers 4` | Maximum expected speakers |

Environment variables `OMP_NUM_THREADS=4` and `MKL_NUM_THREADS=4` are set to prevent PyTorch from consuming all CPU cores.

### Output format

The Python script writes RTTM (Rich Transcription Time Marked) data to stdout:

```
SPEAKER audio 1 0.500 3.200 <NA> <NA> SPEAKER_00 <NA> <NA>
SPEAKER audio 1 3.700 5.100 <NA> <NA> SPEAKER_01 <NA> <NA>
SPEAKER audio 1 8.800 2.400 <NA> <NA> SPEAKER_00 <NA> <NA>
```

Each line describes one speaker segment: start time (seconds), duration (seconds), and speaker label.

### Post-processing

1. **Parse RTTM** -- Each line is parsed into `SpeakerSegment` objects with `label`, `start`, and `end` (start + duration) fields.
2. **Sort by start time** -- Segments are ordered chronologically.
3. **Filter short segments** -- Segments shorter than 0.5 seconds are discarded as segmentation noise. The Python-side collar merge (0.5s in `diarize.py`) handles same-speaker gap filling.

### Saved output

Written as a `DiarizationData` JSON file at `~/.therascript/diarization/<sessionId>.json`:

```typescript
interface DiarizationData {
  speakers: { label: string; start: number; end: number }[]
  speakerCount: number
  metadata: { model: string; duration: number }
}
```

## Step 3: Alignment (Speaker Attribution)

`AlignmentService` (`src/main/ml/AlignmentService.ts`) merges the transcript words with the speaker segments. This is a pure TypeScript computation -- no external process is spawned.

### Speaker label mapping

Raw pyannote labels (`SPEAKER_00`, `SPEAKER_01`, ...) are mapped to human-readable labels (`Person A`, `Person B`, ...) ordered by first appearance in the recording. Up to 8 speakers are supported (A through H).

### Word-to-speaker alignment

For each word in the transcript, the algorithm finds the speaker segment with the greatest temporal overlap:

1. **Overlap-based assignment** -- For each word, calculate the overlap duration with every speaker segment. The segment with the greatest overlap wins.
2. **Nearest-segment fallback** -- If a word falls entirely in a gap between segments (zero overlap with all segments), it is assigned to the nearest segment by boundary distance.

### Sentence boundary correction

After initial alignment, a sentence-aware correction pass fixes misattributions caused by pyannote segment boundaries being 0.5--1.5 seconds off from actual speaker transitions:

- When a speaker change occurs mid-sentence, the algorithm looks back up to 5 words for a sentence boundary (`.`, `!`, `?`).
- If found, all words between the sentence boundary and the speaker change are reassigned to the new speaker.
- Safety checks prevent false corrections: all intermediate words must have had the same speaker, and the new speaker must persist for at least 2 consecutive words.

### Segment reconstruction

Words are grouped into segments based on speaker changes:

- **Multi-speaker** (2+ speakers detected): Each continuous run of words from the same speaker becomes one segment with a `speaker` field (e.g., `"Person A"`).
- **Single speaker** (0--1 speakers detected): Speaker labels are stripped entirely. Segments are split on sentence-ending punctuation instead.

### Saved output

The aligned result overwrites the original transcript file (`~/.therascript/transcripts/<sessionId>.json`), now including speaker information:

```typescript
interface TranscriptData {
  words: { text: string; start: number; end: number; speaker?: string }[]
  segments: { text: string; start: number; end: number; speaker?: string }[]
  metadata: { model: string; language: string; duration: number; diarization?: string }
}
```

## Error Handling

### Timeouts

Both ASR and diarization use a dynamic timeout based on audio duration:

| Step | Formula | Minimum |
|---|---|---|
| ASR (whisper) | 4x estimated audio duration | 60 seconds |
| Diarization (pyannote) | 4x estimated audio duration | 120 seconds |

Audio duration is estimated from the WAV file size: `(fileSize - 44) / (48000 * 2)` (48 kHz, 16-bit mono). On timeout, the process receives `SIGTERM`.

### Failure modes

| Failure | Behavior |
|---|---|
| Binary not found (whisper-cli or Python) | Task fails with descriptive error naming the missing binary and setup script |
| Model file missing | Task fails with error indicating the expected model path |
| Audio file missing | Task fails before spawning the subprocess |
| Process exits with non-zero code | Error lines from stderr are extracted (filtered for "error"/"failed" keywords) and included in the error message |
| JSON output not produced (whisper) | Task fails with "whisper-cli hat keine JSON-Ausgabe erzeugt" |
| Transcript has no words (alignment) | Task fails with "Transkript enthaelt keine Woerter" |
| Missing transcript or diarization file (alignment) | Task fails with descriptive error before alignment begins |
| ENOENT on pyannote spawn | Dev: suggests installing Python 3.10+; Production: reports binary not executable |

### Alignment step

The alignment step is purely computational and does not spawn external processes, so it has no timeout. It fails only if the prerequisite transcript or diarization files are missing or the transcript contains zero words.

## Progress Reporting

Each step reports progress back to the UI via the `onProgress` callback:

### ASR progress

whisper.cpp emits progress lines to stderr in the format `whisper_print_progress_callback: progress = 42%`. The regex `/progress\s*=\s*(\d+)%/` extracts the percentage, which is divided by 100 and passed to `onProgress`.

### Diarization progress

The Python sidecar emits progress lines to stderr in the format `[PROGRESS] 42`. The regex `/\[PROGRESS\]\s*(\d+)/` extracts the value, divided by 100 and forwarded to `onProgress`.

### Alignment progress

Progress is reported at fixed checkpoints: 10% (data loaded), 20% (files parsed), 60% (words aligned), 90% (segments rebuilt), 100% (file written).

## Source Files

| File | Role |
|---|---|
| `src/main/ml/WhisperService.ts` | ASR executor: spawns whisper-cli, parses JSON output |
| `src/main/ml/PyannoteSidecar.ts` | Diarization executor: spawns Python sidecar, parses RTTM |
| `src/main/ml/AlignmentService.ts` | Alignment executor: merges words + speakers, sentence correction |
| `src/main/ml/token-processing.ts` | Whisper token filtering and BPE sub-token merging |
| `src/main/ml/filler-removal.ts` | Filler word removal and segment rebuilding |
| `src/main/ml/resolve-python.ts` | Python sidecar binary resolution (dev vs. production) |
| `src/shared/types/Transcript.ts` | TranscriptData, TranscriptWord, TranscriptSegment types |
| `src/shared/types/Diarization.ts` | DiarizationData, SpeakerSegment types |
