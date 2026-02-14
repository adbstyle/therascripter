#!/usr/bin/env python3
"""
Speaker diarization service using pyannote.audio.

Processes an audio file and outputs speaker segments in RTTM format to stdout.
Progress is reported to stderr for parsing by the Electron main process.

Usage:
    python3 diarize.py --audio <path> [--model-dir <path>] [--min-speakers 1] [--max-speakers 4]

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
import json


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

    # Load model
    try:
        # pyannote community-1 can be loaded from local cache or HuggingFace Hub
        # We check for a local config first, then fall back to hub identifier
        local_config = os.path.join(args.model_dir, "config.yaml")
        if os.path.isfile(local_config):
            pipeline = Pipeline.from_pretrained(local_config)
        else:
            # Fall back to HuggingFace Hub identifier (requires prior download)
            pipeline = Pipeline.from_pretrained(
                "pyannote/speaker-diarization-3.1",
                cache_dir=args.model_dir,
            )

        # Use MPS (Metal) if available on Apple Silicon, otherwise CPU
        if torch.backends.mps.is_available():
            pipeline = pipeline.to(torch.device("mps"))
        else:
            pipeline = pipeline.to(torch.device("cpu"))
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

        # Hook into pyannote progress if available
        # pyannote 3.x uses a hook system for progress tracking
        class ProgressHook:
            def __init__(self):
                self.current_step = 0
                self.total_steps = 4  # segmentation, embedding, clustering, discrete

            def __call__(self, step_name: str, step: int, total: int, **kwargs):
                # Map internal steps to 20-95% range
                progress = 20 + int((step / max(total, 1)) * 75 / self.total_steps)
                progress += int(self.current_step * 75 / self.total_steps)
                report_progress(min(progress, 95))

        # Attempt to use progress hook (pyannote >= 3.1)
        try:
            hook = ProgressHook()
            diarization = pipeline(args.audio, hook=hook, **diarization_params)
        except TypeError as e:
            if "hook" in str(e) or "unexpected keyword argument" in str(e):
                # Fallback: pyannote version without progress hook support
                report_progress(50)
                diarization = pipeline(args.audio, **diarization_params)
            else:
                raise

        report_progress(95)

    except Exception as e:
        print(f"Fehler: Diarization fehlgeschlagen: {e}", file=sys.stderr)
        sys.exit(3)

    # Output RTTM format to stdout
    file_id = os.path.splitext(os.path.basename(args.audio))[0]
    for turn, _, speaker in diarization.itertracks(yield_label=True):
        start = turn.start
        duration = turn.duration
        # RTTM format: SPEAKER <file> <channel> <start> <duration> <NA> <NA> <label> <NA> <NA>
        print(f"SPEAKER {file_id} 1 {start:.3f} {duration:.3f} <NA> <NA> {speaker} <NA> <NA>")

    report_progress(100)


if __name__ == "__main__":
    main()
