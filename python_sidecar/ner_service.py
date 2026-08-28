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
import logging
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

# Obergrenze fürs Warten auf _stderr_lock. Siehe _emit: der Lock ist eine
# Best-Effort-Garantie für Zeilenintegrität, nie eine Vorbedingung fürs
# Schreiben — deshalb ein Timeout statt eines blockierenden `with`.
_STDERR_LOCK_TIMEOUT_SEC = 2

_stderr_lock = threading.Lock()


def _emit(line: str) -> None:
    """
    Eine Zeile in EINEM write() auf stderr schreiben.

    Alle stderr-Ausgaben dieses Scripts laufen hier durch — auch die
    Fehlermeldungen und der flair-Logger (_EmitHandler). Zwei Gründe:
    (1) print() macht zwei write()-Calls (Text, dann Newline); der
    Heartbeat-Thread und der Haupt-Thread würden sich sonst mitten in
    einer Zeile verschränken und der [PROGRESS]-Parser im Main-Prozess
    bekäme Müll. (2) Ein einzelner write() plus der Lock hält die Zeilen
    beider Threads auseinander.

    Der Lock wird mit Timeout genommen und im Zweifel übersprungen: er
    darf niemals blockieren. thread.join(timeout=1) in heartbeat() kann
    den Heartbeat-Thread aufgeben, während der in einem hängenden
    flush() steckt und den Lock hält — ein blockierendes `with` würde
    dann den Haupt-Thread beim nächsten report_progress() für immer
    aufhalten. Der Prozess hinge, obwohl das Ergebnis schon auf stdout
    steht, bis das 900-s-Subprocess-Timeout ihn killt. Eine im Extremfall
    verschränkte Diagnosezeile ist der bessere Preis.
    """
    acquired = _stderr_lock.acquire(timeout=_STDERR_LOCK_TIMEOUT_SEC)
    try:
        sys.stderr.write(line + "\n")
        sys.stderr.flush()
    finally:
        if acquired:
            _stderr_lock.release()


class _EmitHandler(logging.Handler):
    """Leitet flairs Logger über _emit statt über einen eigenen Stream."""

    def emit(self, record: "logging.LogRecord") -> None:
        try:
            _emit(self.format(record))
        except Exception:  # noqa: BLE001 — Logging darf den Lauf nie kippen
            self.handleError(record)


# Token-Budget für einen flair-Mini-Batch: Summe der 512-Token-Zeilen mal
# längster Zeile. Siehe pack_by_budget.
TOKEN_BUDGET = 4096
MAX_SENTENCES_PER_BATCH = 32


def pack_by_budget(items, token_budget=TOKEN_BUDGET, max_sentences=MAX_SENTENCES_PER_BATCH):
    """
    Segmente greedy zu Mini-Batches gruppieren — begrenzt durch ein
    Token-Budget statt durch eine feste Batch-Größe.

    items: Liste von (rows, row_len)-Tupeln pro Segment. `rows` ist die Zahl
    der 512-Token-Fenster, die flair für das Segment erzeugt
    (allow_long_sentences=True, stride=256), `row_len` die Länge des
    längsten dieser Fenster. Rückgabe: Liste von Gruppen, jede Gruppe eine
    Liste von Indizes in `items`; die Originalreihenfolge bleibt erhalten.

    Warum nicht einfach BATCH_SIZE=32: flair padded jede Mini-Batch auf ihr
    längstes Element, der Attention-Speicher wächst also mit
    Zeilen × padded_len². Für Audio-Segmente ist eine feste 32 unkritisch
    (gemessen: 64 × 220 Zeichen bei Batch 32 = 3.23 GiB Live-Peak). Bei
    seitengroßen PDF-Segmenten kippt sie: 11 × 2800 Zeichen ergeben je 1–3
    überlappende 512-Token-Fenster und bei Batch 32 gemessene 14.07 GiB
    gegen das MPS-Ceiling von 9.07 GiB auf 8-GB-Macs → "MPS backend out of
    memory". Mit diesem Budget gemessen: 5.32 GiB für einen einzelnen
    8×512-Forward-Pass (frischer Prozess) bzw. 3.16 GiB Live-Peak über den
    ganzen run_ner-Lauf derselben Eingabe — beides passt. Das Budget ist
    dabei nominal: die Zählung in run_ner unterschätzt die echte
    Padding-Matrix leicht (siehe Kommentar dort); Marge zum Ceiling plus
    CPU-Fallback decken das. Kurze Segmente
    füllen das Budget weiterhin bis MAX_SENTENCES_PER_BATCH aus — der
    3–5×-Speedup der Audio-Pipeline aus Commit ad9c716 bleibt erhalten.

    Ein einzelnes übergroßes Segment bildet immer allein eine Gruppe: die
    erste Aufnahme in eine leere Gruppe ist unbedingt, denn ein Segment
    lässt sich nicht weiter teilen, ohne die Sentence-Grenzen (und damit das
    segmentIndex-Mapping) zu verändern.
    """
    groups = []
    current = []
    current_rows = 0
    current_maxlen = 0

    for i, (rows, row_len) in enumerate(items):
        if current:
            padded = max(current_maxlen, row_len)
            fits_budget = (current_rows + rows) * padded <= token_budget
            fits_count = len(current) < max_sentences
            if not (fits_budget and fits_count):
                groups.append(current)
                current = []
                current_rows = 0
                current_maxlen = 0

        current.append(i)
        current_rows += rows
        current_maxlen = max(current_maxlen, row_len)

    if current:
        groups.append(current)

    return groups


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
        from pathlib import Path

        import flair
        from flair.data import Sentence
        from flair.nn import Classifier

        # Belt-and-braces zum FLAIR_CACHE_ROOT-Env oben: direkt am Modul pinnen,
        # falls eine künftige flair-Version das Import-Zeitpunkt-Binding ändert.
        flair.cache_root = Path(model_dir)

        # Redirect flair's logger from stdout to stderr so JSON output stays
        # clean. Über _EmitHandler, damit auch flairs Zeilen den stderr-Lock
        # respektieren und nicht mit einem [HEARTBEAT] kollidieren.
        flair.logger.handlers.clear()
        flair.logger.addHandler(_EmitHandler())
    except ImportError as e:
        _emit(f"Fehler: Benötigtes Paket nicht installiert: {e}")
        _emit("Führen Sie scripts/setup-ner.sh aus, um Abhängigkeiten zu installieren.")
        sys.exit(2)

    report_progress(10)

    # MPS wie in diarize.py: der 550M-Parameter-Encoder auf 4 CPU-Threads
    # (OMP_NUM_THREADS-Pin) war der langsamste Pipeline-Step. flair liest
    # flair.device beim Modell-Load.
    # mps_active steuert unten den OOM-Fallback; der fasst torch nur an,
    # wenn MPS aktiv wurde — also nach erfolgreichem Import.
    mps_active = False
    try:
        import torch

        if torch.backends.mps.is_available():
            flair.device = torch.device("mps")
            mps_active = True
            _emit("MPS-Backend aktiv (Apple Silicon GPU)")
    except Exception as e:
        _emit(f"MPS nicht verfügbar, nutze CPU: {e}")

    # Load NER model (Cache-Verzeichnis via FLAIR_CACHE_ROOT, gesetzt vor dem Import)
    try:
        tagger = Classifier.load("flair/ner-german-large")
    except Exception as e:
        _emit(f"Fehler: NER-Modell konnte nicht geladen werden: {e}")
        _emit("Führen Sie scripts/setup-ner.sh --model aus, um das Modell herunterzuladen.")
        sys.exit(2)

    report_progress(25)

    # Process segments — gebatcht statt Satz-für-Satz: predict() über eine
    # Liste nutzt mini_batch_size (flair sortiert intern nach Länge für
    # effizientes Padding). Vorher war jedes Segment ein eigener Forward-Pass
    # durch XLM-RoBERTa-large — bei hunderten Segmenten pro Stunde Audio der
    # dominante Kostenfaktor dieses Steps (~3-5×). Die Batch-Größe ist aber
    # nicht mehr fix, sondern folgt einem Token-Budget (pack_by_budget):
    # seitengroße PDF-Segmente sprengten bei fixen 32 den MPS-Speicher.
    all_entities = []

    try:
        # (text, original_segment_index) — leere Segmente überspringen, aber
        # den Original-Index für das segmentIndex-Mapping behalten. Die Texte
        # werden mitgeführt statt fertiger Sentence-Objekte: sie sind Input
        # fürs Token-Zählen und erlauben im CPU-Fallback ein Neu-Erzeugen.
        indexed_texts = [
            (text, idx)
            for idx, segment in enumerate(segments)
            if (text := segment.get("text", "")).strip()
        ]

        # rows/row_len mit flairs eigenem Tokenizer und dessen
        # Fenster-Settings zählen. Das ist eine konservative NÄHERUNG der
        # echten Padding-Matrix, keine Kopie: flair tokenisiert intern über
        # die Wortliste (is_split_into_words=True) und hängt als
        # FLERT-Modell ±64 Wörter Kontext aus den Batch-Nachbarn an — beides
        # macht die echten Zeilen etwas LÄNGER als hier gezählt. Die Marge
        # zum 9.07-GiB-Ceiling (gemessen 3.16 GiB Live-Peak) plus der
        # CPU-Fallback decken die Unterzählung. emb.* sind flair-Interna und
        # flair ist in requirements-ner.txt nicht gepinnt — verschiebt eine
        # künftige Version die Attribute, degradieren wir auf eine grobe
        # Konstant-Schätzung (Gruppen à 8), statt hier zu sterben: ein
        # AttributeError würde sonst JEDE Anonymisierung nach error kippen.
        try:
            emb = tagger.embeddings
            items = []
            for text, _ in indexed_texts:
                enc = emb.tokenizer(
                    [text],
                    max_length=emb.tokenizer.model_max_length,
                    stride=emb.stride,
                    return_overflowing_tokens=emb.allow_long_sentences,
                    truncation=emb.truncate,
                )
                rows = len(enc["input_ids"])
                row_len = max(len(r) for r in enc["input_ids"])
                items.append((rows, row_len))
        except Exception as count_error:  # noqa: BLE001 — flair-Interna verschoben
            _emit(f"Token-Zählung nicht möglich ({count_error}) — konservative Gruppierung")
            items = [(1, 512)] * len(indexed_texts)

        groups = pack_by_budget(items)

        done = 0
        for group in groups:
            group_rows = sum(items[i][0] for i in group)
            group_padded = max(items[i][1] for i in group)
            _emit(f"[BATCH] sentences={len(group)} rows={group_rows} padded={group_padded}")

            sentences = [Sentence(indexed_texts[i][0]) for i in group]
            try:
                tagger.predict(sentences, mini_batch_size=len(sentences))
            except RuntimeError as e:
                # MPS-OOM ist kein Verarbeitungsfehler: einmalig auf CPU
                # zurückfallen (langsamer, aber Swap-gedeckt) und ab hier
                # alle restlichen Batches dort rechnen. Kein zweiter
                # MPS-Versuch — das Ceiling ändert sich nicht.
                if not (mps_active and "out of memory" in str(e).lower()):
                    raise
                _emit("MPS out of memory — wechsle auf CPU und wiederhole verbleibende Batches")
                mps_active = False
                flair.device = torch.device("cpu")
                tagger.to(flair.device)
                try:
                    torch.mps.empty_cache()
                except Exception as cache_error:  # noqa: BLE001 — best effort
                    _emit(f"torch.mps.empty_cache() fehlgeschlagen: {cache_error}")
                # Sentences neu erzeugen: der abgebrochene Forward-Pass kann
                # halb-annotierte Objekte hinterlassen haben.
                sentences = [Sentence(indexed_texts[i][0]) for i in group]
                tagger.predict(sentences, mini_batch_size=len(sentences))

            for sentence, i in zip(sentences, group):
                idx = indexed_texts[i][1]
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

            # Report progress: 25-95 % anteilig nach abgearbeiteten Segmenten
            # (nicht Gruppen — die sind je nach Segmentlänge sehr ungleich groß)
            done += len(group)
            pct = 25 + int(done / max(1, len(indexed_texts)) * 70)
            report_progress(min(pct, 95))

    except Exception as e:
        _emit(f"Fehler: NER-Verarbeitung fehlgeschlagen: {e}")
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
        _emit(f"Fehler: Transkript-Datei nicht gefunden: {args.transcript}")
        sys.exit(1)

    report_progress(0)

    # Load transcript
    try:
        with open(args.transcript, "r", encoding="utf-8") as f:
            transcript = json.load(f)
    except (json.JSONDecodeError, IOError) as e:
        _emit(f"Fehler: Transkript konnte nicht geladen werden: {e}")
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
