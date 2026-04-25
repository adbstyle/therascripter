#!/usr/bin/env python3
"""Named Entity Recognition dispatcher.

Selects a backend (flair / gliner / ai4privacy) and forwards segment-level
prediction to the corresponding `ner_backends/<backend>_backend.py` module.
Native entity-type strings are passed through unchanged; canonical mapping
to Therascript's PlaceholderType happens TypeScript-side in entity-merger.ts.

Usage:
    python3 ner_service.py \
        --transcript <path> \
        --backend <flair|gliner|ai4privacy> \
        --hf-model <huggingface-identifier> \
        [--model-dir <path>]

Output format (stdout JSON):
    {
      "entities": [
        {"text": "Dr. Müller", "type": "PER", "segmentIndex": 0,
         "charStart": 0, "charEnd": 10, "confidence": 0.96}
      ],
      "metadata": {
        "backend": "flair",
        "model": "flair/ner-german-large",
        "segmentCount": N,
        "entityCount": N
      }
    }

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
import json
import os
import sys

# Force offline loading in production. Both env vars must be set BEFORE any
# huggingface_hub / transformers / flair / gliner import; the backend modules
# import these libraries lazily inside predict(), so setting them here is safe.
# Mirrors the pattern in diarize.py.
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")


def report_progress(percent: int) -> None:
    """Print progress to stderr for TaskExecutor parsing."""
    print(f"[PROGRESS] {percent}", file=sys.stderr, flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="NER dispatcher (flair/gliner/ai4privacy)")
    parser.add_argument("--transcript", required=True, help="Path to transcript JSON file")
    parser.add_argument(
        "--backend",
        required=True,
        choices=["flair", "gliner", "ai4privacy"],
        help="NER backend to dispatch to",
    )
    parser.add_argument(
        "--hf-model",
        required=True,
        help="HuggingFace identifier of the model to load",
    )
    parser.add_argument(
        "--model-dir",
        default=os.path.expanduser("~/.therascript/models/ner"),
        help="Directory for backend model cache",
    )
    args = parser.parse_args()

    # Validate transcript file
    if not os.path.isfile(args.transcript):
        print(f"Fehler: Transkript-Datei nicht gefunden: {args.transcript}", file=sys.stderr)
        sys.exit(1)

    report_progress(0)

    # Load transcript
    try:
        with open(args.transcript, "r", encoding="utf-8") as f:
            transcript = json.load(f)
    except (json.JSONDecodeError, IOError) as e:
        print(f"Fehler: Transkript konnte nicht geladen werden: {e}", file=sys.stderr)
        sys.exit(1)

    segments = transcript.get("segments", [])
    if not segments:
        # No segments → no entities, output empty result
        result = {
            "entities": [],
            "metadata": {
                "backend": args.backend,
                "model": args.hf_model,
                "segmentCount": 0,
                "entityCount": 0,
            },
        }
        print(json.dumps(result))
        report_progress(100)
        return

    report_progress(5)

    # Dispatch to backend
    try:
        if args.backend == "flair":
            from ner_backends import flair_backend as backend
        elif args.backend == "gliner":
            from ner_backends import gliner_backend as backend  # type: ignore
        elif args.backend == "ai4privacy":
            from ner_backends import ai4privacy_backend as backend  # type: ignore
        else:
            print(f"Fehler: Unbekanntes Backend '{args.backend}'", file=sys.stderr)
            sys.exit(1)
    except ImportError as e:
        print(f"Fehler: Backend '{args.backend}' nicht verfügbar: {e}", file=sys.stderr)
        print(
            "Führen Sie scripts/setup-ner.sh aus, um Abhängigkeiten zu installieren.",
            file=sys.stderr,
        )
        sys.exit(2)

    # Load model + run prediction
    try:
        entities = backend.predict(
            segments=segments,
            hf_id=args.hf_model,
            model_dir=args.model_dir,
            progress_cb=report_progress,
        )
    except FileNotFoundError as e:
        print(f"Fehler: Modell-Datei nicht gefunden ({args.backend}): {e}", file=sys.stderr)
        print(
            "Führen Sie scripts/setup-ner.sh --model aus, um das Modell herunterzuladen.",
            file=sys.stderr,
        )
        sys.exit(2)
    except Exception as e:
        print(f"Fehler: NER-Verarbeitung fehlgeschlagen ({args.backend}): {e}", file=sys.stderr)
        sys.exit(3)

    # Output result
    result = {
        "entities": entities,
        "metadata": {
            "backend": args.backend,
            "model": args.hf_model,
            "segmentCount": len(segments),
            "entityCount": len(entities),
        },
    }

    print(json.dumps(result, ensure_ascii=False))
    report_progress(100)


if __name__ == "__main__":
    main()
