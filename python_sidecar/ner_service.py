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

Liveness format (stderr):
    [HEARTBEAT]

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
import threading
from contextlib import contextmanager

# CSP-Äquivalent (wie in diarize.py): Alle HuggingFace-Hub-Netzwerk-Requests
# blockieren. CSP connect-src 'none' gilt nur im Electron-Renderer, nicht im
# Python-Subprocess. Ohne diese Flags würde flair/transformers bei fehlendem
# lokalen Cache (z. B. Tokenizer von xlm-roberta-large) stillschweigend über
# HTTP nachladen. Muss gesetzt werden, BEVOR flair importiert wird.
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

HEARTBEAT_INTERVAL_SEC = 10

_stderr_lock = threading.Lock()


def _emit(line: str) -> None:
    """
    Eine Zeile atomar auf stderr schreiben. print() macht zwei separate
    write()-Calls (Text, dann Newline) — der Heartbeat-Thread und der
    Haupt-Thread teilen sich stderr und würden sich sonst mitten in einer
    Zeile verschränken, was den [PROGRESS]-Parser im Main-Prozess bricht.
    """
    with _stderr_lock:
        sys.stderr.write(line + "\n")
        sys.stderr.flush()


def report_progress(percent: int) -> None:
    """Print progress to stderr for TaskExecutor parsing."""
    _emit(f"[PROGRESS] {percent}")


@contextmanager
def heartbeat():
    """
    Daemon-Thread, der alle HEARTBEAT_INTERVAL_SEC ein Lebenszeichen auf
    stderr schreibt.

    Der ProcessWatchdog im Main-Prozess kannte bisher nur [PROGRESS] als
    Lebenszeichen. Zwischen `import flair` (10 %) und dem Ende von
    `Classifier.load()` (25 %) liegt aber der Load von 2.24 GB
    pytorch_model.bin: auf einer Maschine mit wenig freiem RAM ist das
    überwiegend I/O-Wait (gemessen: 281 s wall vs. 42 s CPU bei vollem
    Swap) und damit weit über der 120-s-Stall-Schwelle → der Watchdog
    killte die Prozessgruppe mitten im gesunden Modell-Load.

    Gleiches gilt für die Inferenz: bei einem einzigen Batch (PDF mit
    einer Seite = ein Segment) feuert zwischen 25 % und 95 % ebenfalls
    kein einziges [PROGRESS].
    """
    stop = threading.Event()

    def beat() -> None:
        while not stop.wait(HEARTBEAT_INTERVAL_SEC):
            _emit("[HEARTBEAT]")

    thread = threading.Thread(target=beat, name="heartbeat", daemon=True)
    thread.start()
    try:
        yield
    finally:
        # Deterministisch stoppen (auch bei sys.exit → SystemExit), sonst
        # könnte der Thread beim Interpreter-Shutdown noch auf stderr
        # schreiben und "Exception ignored in thread"-Rauschen erzeugen.
        stop.set()
        thread.join(timeout=1)


def run_ner(model_dir: str, segments: list) -> list:
    """Import flair, load the model and tag all segments. Returns entities."""
    # Import flair (heavy import, ~3-5s)
    try:
        import logging
        from pathlib import Path

        import flair
        from flair.data import Sentence
        from flair.nn import Classifier

        # Belt-and-braces zum FLAIR_CACHE_ROOT-Env oben: direkt am Modul pinnen,
        # falls eine künftige flair-Version das Import-Zeitpunkt-Binding ändert.
        flair.cache_root = Path(model_dir)

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

    # MPS wie in diarize.py: der 550M-Parameter-Encoder auf 4 CPU-Threads
    # (OMP_NUM_THREADS-Pin) war der langsamste Pipeline-Step. flair liest
    # flair.device beim Modell-Load.
    try:
        import torch

        if torch.backends.mps.is_available():
            flair.device = torch.device("mps")
            print("MPS-Backend aktiv (Apple Silicon GPU)", file=sys.stderr)
    except Exception as e:
        print(f"MPS nicht verfügbar, nutze CPU: {e}", file=sys.stderr)

    # Load NER model (Cache-Verzeichnis via FLAIR_CACHE_ROOT, gesetzt vor dem Import)
    try:
        tagger = Classifier.load("flair/ner-german-large")
    except Exception as e:
        print(f"Fehler: NER-Modell konnte nicht geladen werden: {e}", file=sys.stderr)
        print(
            "Führen Sie scripts/setup-ner.sh --model aus, um das Modell herunterzuladen.",
            file=sys.stderr,
        )
        sys.exit(2)

    report_progress(25)

    # Process segments — gebatcht statt Satz-für-Satz: predict() über eine
    # Liste nutzt mini_batch_size (flair sortiert intern nach Länge für
    # effizientes Padding). Vorher war jedes Segment ein eigener Forward-Pass
    # durch XLM-RoBERTa-large — bei hunderten Segmenten pro Stunde Audio der
    # dominante Kostenfaktor dieses Steps (~3-5×).
    all_entities = []
    BATCH_SIZE = 32

    try:
        # (sentence, original_segment_index) — leere Segmente überspringen,
        # aber den Original-Index für segmentIndex-Mapping behalten
        indexed_sentences = [
            (Sentence(text), idx)
            for idx, segment in enumerate(segments)
            if (text := segment.get("text", "")).strip()
        ]

        for batch_start in range(0, len(indexed_sentences), BATCH_SIZE):
            batch = indexed_sentences[batch_start : batch_start + BATCH_SIZE]
            tagger.predict([s for s, _ in batch], mini_batch_size=BATCH_SIZE)

            for sentence, idx in batch:
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

            # Report progress: 25-95% range mapped to batch processing
            done = min(batch_start + BATCH_SIZE, len(indexed_sentences))
            pct = 25 + int(done / max(1, len(indexed_sentences)) * 70)
            report_progress(min(pct, 95))

    except Exception as e:
        print(f"Fehler: NER-Verarbeitung fehlgeschlagen: {e}", file=sys.stderr)
        sys.exit(3)

    return all_entities


def main() -> None:
    parser = argparse.ArgumentParser(description="NER via flair/ner-german-large")
    parser.add_argument("--transcript", required=True, help="Path to transcript JSON file")
    parser.add_argument(
        "--model-dir",
        default=os.path.expanduser("~/.therascript/models/ner"),
        help="Directory for flair model cache",
    )
    args = parser.parse_args()

    # flair bindet cache_root beim IMPORT (flair/__init__.py liest FLAIR_CACHE_ROOT
    # einmalig, Default ~/.flair) — die Variable muss also VOR `import flair` gesetzt
    # sein, sonst wird das heruntergeladene Modell in --model-dir ignoriert und flair
    # greift auf ~/.flair zurück (auf Endnutzer-Macs leer → Hub-Download-Versuch).
    # HF_HOME lenkt zusätzlich alle huggingface_hub-Zugriffe ohne explizites
    # cache_dir (z. B. Tokenizer-Auflösung) unter das App-Modellverzeichnis statt
    # ~/.cache/huggingface.
    os.environ["FLAIR_CACHE_ROOT"] = args.model_dir
    os.environ.setdefault("HF_HOME", os.path.join(args.model_dir, "hf"))

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

    # Ab hier laufen Import, Modell-Load und Inferenz — Phasen, in denen
    # minutenlang kein [PROGRESS] fällt. Der Heartbeat hält den Watchdog
    # im Main-Prozess ruhig, ohne den Progress-Wert zu verändern.
    with heartbeat():
        all_entities = run_ner(args.model_dir, segments)

    # Output result
    result = {
        "entities": all_entities,
        "metadata": {
            "model": "flair/ner-german-large",
            "segmentCount": len(segments),
            "entityCount": len(all_entities),
        },
    }

    print(json.dumps(result, ensure_ascii=False))
    report_progress(100)


if __name__ == "__main__":
    main()
