#!/usr/bin/env python3
"""
Speaker diarization service using pyannote.audio.

Processes an audio file and outputs speaker segments in RTTM format to stdout.
Progress is reported to stderr for parsing by the Electron main process.

Usage:
    python3 diarize.py --audio <path> [--model-dir <path>] [--min-speakers 1] [--max-speakers 4]
                       [--collar 0.5]

Output format (RTTM, one line per speaker segment):
    SPEAKER <file-id> 1 <start-sec> <duration-sec> <NA> <NA> <speaker-label> <NA> <NA>

Progress format (stderr):
    [PROGRESS] 0
    [PROGRESS] 50
    [PROGRESS] 100

Exit codes:
    0 = success
    1 = invalid arguments / file not found
    2 = model load error
    3 = processing error
"""

import argparse
import os
import sys

# CSP-Äquivalent: Alle HuggingFace-Hub-Netzwerk-Requests blockieren.
# CSP connect-src 'none' gilt nur im Electron-Renderer, nicht im Python-Subprocess.
# Ohne diese Flags könnte pyannote/huggingface-hub Sub-Models bei fehlendem lokalen
# Cache stillschweigend über HTTP nachziehen. Muss gesetzt werden, BEVOR pyannote
# importiert wird (oben im File, nicht in main()).
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")


def report_progress(percent: int) -> None:
    """Print progress to stderr for TaskExecutor parsing."""
    print(f"[PROGRESS] {percent}", file=sys.stderr, flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Speaker diarization via pyannote.audio")
    parser.add_argument("--audio", required=True, help="Path to WAV audio file")
    parser.add_argument(
        "--model-dir",
        default=os.path.expanduser("~/.therascript/models/diarization"),
        help="Directory containing pyannote model files",
    )
    parser.add_argument("--min-speakers", type=int, default=1, help="Minimum speakers (default: 1)")
    parser.add_argument("--max-speakers", type=int, default=4, help="Maximum speakers (default: 4)")
    parser.add_argument(
        "--collar",
        type=float,
        default=0.5,
        help="Post-processing collar: merge same-speaker segments separated by less than this (seconds)",
    )
    parser.add_argument(
        "--hf-model",
        required=True,
        help="HuggingFace pipeline identifier, e.g. pyannote/speaker-diarization-3.1",
    )
    args = parser.parse_args()

    # Validate audio file
    if not os.path.isfile(args.audio):
        print(f"Fehler: Audiodatei nicht gefunden: {args.audio}", file=sys.stderr)
        sys.exit(1)

    report_progress(0)

    # Import pyannote (heavy import, ~2-3s)
    try:
        from pyannote.audio import Pipeline
        import torch
    except ImportError as e:
        print(f"Fehler: Benötigtes Paket nicht installiert: {e}", file=sys.stderr)
        print("Führen Sie scripts/setup-pyannote.sh aus, um Abhängigkeiten zu installieren.", file=sys.stderr)
        sys.exit(2)

    report_progress(5)

    # Load model from HuggingFace-Cache-Layout unter args.model_dir.
    # HF_HUB_OFFLINE=1 (oben gesetzt) stellt sicher, dass kein HTTP-Fallback greift.
    try:
        pipeline = Pipeline.from_pretrained(
            args.hf_model,
            cache_dir=args.model_dir,
        )

        # Use MPS (Metal) if available on Apple Silicon, otherwise CPU
        if torch.backends.mps.is_available():
            pipeline = pipeline.to(torch.device("mps"))
        else:
            pipeline = pipeline.to(torch.device("cpu"))

        # Reduce over-segmentation: fill short intra-speaker gaps (default 0.0 is too aggressive).
        # Set after .to() to ensure the parameter survives device transfer.
        pipeline.segmentation.min_duration_off = 0.5
    except Exception as e:
        print(f"Fehler: Pyannote-Modell konnte nicht geladen werden: {e}", file=sys.stderr)
        print(
            f"Modellverzeichnis: {args.model_dir}",
            file=sys.stderr,
        )
        print("Führen Sie scripts/setup-pyannote.sh --model aus, um das Modell herunterzuladen.", file=sys.stderr)
        sys.exit(2)

    report_progress(20)

    # Run diarization
    try:
        diarization_params = {}
        if args.min_speakers > 0:
            diarization_params["min_speakers"] = args.min_speakers
        if args.max_speakers > 0:
            diarization_params["max_speakers"] = args.max_speakers

        # Progress hook matching pyannote.audio 4.x protocol
        class ProgressHook:
            def __init__(self):
                self.steps_seen: list[str] = []

            def __enter__(self):
                return self

            def __exit__(self, *args):
                pass

            def __call__(self, step_name, step_artifact, file=None,
                         total=None, completed=None):
                if step_name not in self.steps_seen:
                    self.steps_seen.append(step_name)

                if completed is None or total is None:
                    return

                step_index = self.steps_seen.index(step_name)
                n_steps = max(len(self.steps_seen), 4)
                # Map to 20-95% range
                base = 20 + int(step_index * 75 / n_steps)
                step_progress = int((completed / max(total, 1)) * 75 / n_steps)
                report_progress(min(base + step_progress, 95))

        hook = ProgressHook()
        diarization = pipeline(args.audio, hook=hook, **diarization_params)

        report_progress(95)

    except Exception as e:
        print(f"Fehler: Diarization fehlgeschlagen: {e}", file=sys.stderr)
        sys.exit(3)

    # Extract Annotation from DiarizeOutput (pyannote 4.x returns a dataclass)
    if hasattr(diarization, 'speaker_diarization'):
        annotation = diarization.speaker_diarization
    else:
        annotation = diarization

    # Post-processing: merge same-speaker segments separated by short gaps.
    # annotation.support(collar) fills gaps < collar seconds between same-speaker segments,
    # dramatically reducing over-segmentation artifacts.
    if args.collar > 0:
        annotation = annotation.support(collar=args.collar)

    # Output RTTM format to stdout
    file_id = os.path.splitext(os.path.basename(args.audio))[0]
    for turn, _, speaker in annotation.itertracks(yield_label=True):
        start = turn.start
        duration = turn.duration
        # RTTM format: SPEAKER <file> <channel> <start> <duration> <NA> <NA> <label> <NA> <NA>
        print(f"SPEAKER {file_id} 1 {start:.3f} {duration:.3f} <NA> <NA> {speaker} <NA> <NA>")

    report_progress(100)


if __name__ == "__main__":
    main()
