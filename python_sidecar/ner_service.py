#!/usr/bin/env python3
"""
Named Entity Recognition service using flair/ner-german-large.

Processes transcript segments and outputs detected entities in JSON format to stdout.
Progress is reported to stderr for parsing by the Electron main process.

Usage:
    python3 ner_service.py --transcript <path> [--model-dir <path>]

Output format (stdout JSON):
    {
      "entities": [
        {"text": "Dr. Müller", "type": "PER", "segment_index": 0,
         "char_start": 0, "char_end": 10, "confidence": 0.96}
      ],
      "metadata": {"model": "flair/ner-german-large", ...}
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


def report_progress(percent: int) -> None:
    """Print progress to stderr for TaskExecutor parsing."""
    print(f"[PROGRESS] {percent}", file=sys.stderr, flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="NER via flair/ner-german-large")
    parser.add_argument("--transcript", required=True, help="Path to transcript JSON file")
    parser.add_argument(
        "--model-dir",
        default=os.path.expanduser("~/.therascript/models/ner"),
        help="Directory for flair model cache",
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
                "model": "flair/ner-german-large",
                "segmentCount": 0,
                "entityCount": 0,
            },
        }
        print(json.dumps(result))
        report_progress(100)
        return

    report_progress(5)

    # Import flair (heavy import, ~3-5s)
    try:
        import logging

        import flair
        from flair.data import Sentence
        from flair.nn import Classifier

        # Redirect flair's logger from stdout to stderr so JSON output stays clean
        flair.logger.handlers.clear()
        flair.logger.addHandler(logging.StreamHandler(sys.stderr))
    except ImportError as e:
        print(f"Fehler: Benötigtes Paket nicht installiert: {e}", file=sys.stderr)
        print(
            "Führen Sie scripts/setup-ner.sh aus, um Abhängigkeiten zu installieren.",
            file=sys.stderr,
        )
        sys.exit(2)

    report_progress(10)

    # Load NER model
    try:
        # flair caches models in ~/.flair/ by default
        # We set FLAIR_CACHE_ROOT to keep models in our directory
        os.environ["FLAIR_CACHE_ROOT"] = args.model_dir
        tagger = Classifier.load("flair/ner-german-large")
    except Exception as e:
        print(f"Fehler: NER-Modell konnte nicht geladen werden: {e}", file=sys.stderr)
        print(
            "Führen Sie scripts/setup-ner.sh --model aus, um das Modell herunterzuladen.",
            file=sys.stderr,
        )
        sys.exit(2)

    report_progress(25)

    # Process segments
    all_entities = []
    total = len(segments)

    try:
        for idx, segment in enumerate(segments):
            text = segment.get("text", "")
            if not text.strip():
                continue

            sentence = Sentence(text)
            tagger.predict(sentence)

            for entity in sentence.get_spans("ner"):
                all_entities.append(
                    {
                        "text": entity.text,
                        "type": entity.get_label("ner").value,
                        "segmentIndex": idx,
                        "charStart": entity.start_position,
                        "charEnd": entity.end_position,
                        "confidence": round(entity.get_label("ner").score, 4),
                    }
                )

            # Report progress: 25-95% range mapped to segment processing
            pct = 25 + int((idx + 1) / total * 70)
            report_progress(min(pct, 95))

    except Exception as e:
        print(f"Fehler: NER-Verarbeitung fehlgeschlagen: {e}", file=sys.stderr)
        sys.exit(3)

    # Output result
    result = {
        "entities": all_entities,
        "metadata": {
            "model": "flair/ner-german-large",
            "segmentCount": total,
            "entityCount": len(all_entities),
        },
    }

    print(json.dumps(result, ensure_ascii=False))
    report_progress(100)


if __name__ == "__main__":
    main()
