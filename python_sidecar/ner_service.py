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
import shutil
import sys
import threading
import time
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

# Untergrenze der adaptiven Budget-Halbierung (siehe run_ner): 512 Slots sind
# genau eine 512-Token-Zeile — darunter wäre jede Gruppe ohnehin ein Singleton
# und ein weiteres Halbieren könnte nichts mehr teilen.
MIN_TOKEN_BUDGET = 512

# Fenster-Geometrie von flair/ner-german-large (XLM-RoBERTa-large):
# model_max_length 512, stride 256 bei allow_long_sentences=True.
WINDOW_LEN = 512
WINDOW_STRIDE = 256


# Der von HuggingFace gelieferte Checkpoint liegt im ALTEN torch-Pickle-Format.
# torch schiebt den dann Byte für Byte durch den Pickle-Parser; gemessen 14.3 s
# gegen 8.0 s, wenn dieselben fp32-Gewichte einmal im modernen Zip-Format neu
# gespeichert wurden, und 6.4 s mit zusätzlichem mmap. Das Legacy-Format kann
# kein mmap (torch verlangt dafür einen Pfad und das neue Format), deshalb
# konvertieren wir einmalig und laden ab dann aus dieser Kopie. Gerundet wird
# dabei nichts — es sind bit-identisch dieselben fp32-Werte, nur anders
# serialisiert. (fp16 als zusätzlicher Hebel: Issue #131.)
FAST_CHECKPOINT_NAME = "ner-german-large-fast.pt"

# Die Kopie belegt zusätzliche ~2.1 GB. Unter diesem Schwellwert wird nicht
# konvertiert, damit das Modellverzeichnis auf knappen Platten nicht volläuft
# (die Erstinstallation verlangt 5 GB frei, die Modelle brauchen davon ~4.1 GB).
FAST_CHECKPOINT_MIN_FREE_BYTES = 3 * 1024**3


def should_write_fast_checkpoint(path, free_bytes, source_bytes):
    """
    Entscheidet, ob der konvertierte Checkpoint geschrieben werden soll.

    Reine Funktion ohne Dateisystem-Zugriff, damit sie testbar ist. Geschrieben
    wird nur, wenn die Datei fehlt UND nach dem Schreiben noch der Puffer aus
    FAST_CHECKPOINT_MIN_FREE_BYTES übrig bleibt. Fehlt der Platz, läuft alles
    weiter wie bisher — nur eben mit dem langsameren Legacy-Load.
    """
    if not path:
        return False
    return free_bytes - source_bytes >= FAST_CHECKPOINT_MIN_FREE_BYTES


def estimate_item(text, window=WINDOW_LEN, stride=WINDOW_STRIDE):
    """
    (rows, row_len) allein aus der Textlänge schätzen — Fallback, wenn flairs
    Tokenizer-Interna nicht erreichbar sind (siehe run_ner).

    Deutscher Fliesstext ergibt bei XLM-R gemessen ~3.9 Zeichen pro Subtoken;
    geteilt wird bewusst durch 3, damit die Schätzung ÜBER dem echten Wert
    liegt. Eine Unterschätzung wäre hier gefährlich: die frühere Konstante
    (1, 512) zählte jedes seitengroße Segment als eine einzige Zeile, obwohl
    es real 2–3 überlappende Fenster sind — Gruppen à 8 Seiten hätten damit
    ~24×512 Slots erreicht und genau das OOM reproduziert, das das Budget
    verhindern soll.
    """
    subtokens = max(1, len(text) // 3)
    if subtokens <= window:
        return (1, min(window, subtokens))
    step = window - stride
    return (1 + -(-(subtokens - window) // step), window)


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


def _write_fast_checkpoint(tagger, fast_path):
    """
    Den geladenen Tagger einmalig im modernen torch-Format ablegen.

    Atomar über eine temporäre Datei plus os.replace: ein Abbruch mitten im
    Schreiben (SIGKILL, volle Platte) darf keinen halben Checkpoint
    hinterlassen, den der nächste Lauf für gültig hält. Jeder Fehler ist
    folgenlos — der nächste Lauf nimmt wieder den Original-Pfad.
    """
    try:
        free_bytes = shutil.disk_usage(os.path.dirname(fast_path) or ".").free
        # Grösse der Quelle als Schätzung für die Zielgrösse (fp32 bleibt fp32).
        source_bytes = 2 * 1024**3
        if not should_write_fast_checkpoint(fast_path, free_bytes, source_bytes):
            _emit(
                "Zu wenig freier Speicher für den schnellen Checkpoint — "
                f"{free_bytes / 1024**3:.1f} GB frei, überspringe Konvertierung"
            )
            return
        tmp_path = f"{fast_path}.tmp"
        started = time.monotonic()
        tagger.save(tmp_path)
        os.replace(tmp_path, fast_path)
        _emit(
            "Schneller Checkpoint geschrieben "
            f"({time.monotonic() - started:.1f}s) — nächster Lauf lädt schneller"
        )
    except Exception as e:  # noqa: BLE001 — reine Optimierung, nie fatal
        _emit(f"Schneller Checkpoint konnte nicht geschrieben werden: {e}")
        try:
            os.remove(f"{fast_path}.tmp")
        except OSError:
            pass


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
    # Der OOM-Pfad unten liest das aktive Device direkt aus flair.device statt
    # aus einem mitgeführten Flag — zwei Zustände, die synchron bleiben müssen,
    # sind eine Fehlerquelle. flair setzt device beim Import nur auf cuda oder
    # cpu (flair/__init__.py), mps also ausschliesslich hier: `on_mps()` ist
    # damit genau dann wahr, wenn dieser Import geklappt hat und `torch`
    # gebunden ist.
    try:
        import torch

        if torch.backends.mps.is_available():
            flair.device = torch.device("mps")
            _emit("MPS-Backend aktiv (Apple Silicon GPU)")
    except Exception as e:
        _emit(f"MPS nicht verfügbar, nutze CPU: {e}")

    # Load NER model (Cache-Verzeichnis via FLAIR_CACHE_ROOT, gesetzt vor dem Import)
    #
    # Zwei Wege: bevorzugt aus dem konvertierten Checkpoint (modernes Format,
    # mmap-fähig — siehe FAST_CHECKPOINT_NAME), sonst aus dem Original mit
    # anschliessender einmaliger Konvertierung. Der Fast-Pfad ist reine
    # Beschleunigung: schlägt er fehl, wird die Datei verworfen und das Original
    # geladen, damit ein korrupter Checkpoint die Anonymisierung nie blockiert.
    fast_path = os.path.join(model_dir, FAST_CHECKPOINT_NAME)
    tagger = None

    if os.path.isfile(fast_path):
        try:
            # flair ruft torch.load mit einem FILE-OBJEKT auf
            # (flair/file_utils.py: load_torch_state) — damit ist mmap nicht
            # möglich, torch verlangt dafür einen Pfad. Der Patch ersetzt genau
            # diesen einen Aufruf. flair.nn.model importiert den Namen direkt,
            # deshalb muss er an BEIDEN Stellen ersetzt werden.
            import flair.file_utils
            import flair.nn.model

            def _load_mmap(model_file):
                return torch.load(
                    model_file, map_location="cpu", weights_only=False, mmap=True
                )

            flair.file_utils.load_torch_state = _load_mmap
            flair.nn.model.load_torch_state = _load_mmap
            started = time.monotonic()
            tagger = Classifier.load(fast_path)
            _emit(f"Modell aus konvertiertem Checkpoint geladen ({time.monotonic() - started:.1f}s)")
        except Exception as fast_error:  # noqa: BLE001 — Fast-Pfad ist optional
            _emit(f"Konvertierter Checkpoint unbrauchbar ({fast_error}) — nutze Original")
            tagger = None
            try:
                os.remove(fast_path)
            except OSError:
                pass

    if tagger is None:
        try:
            started = time.monotonic()
            tagger = Classifier.load("flair/ner-german-large")
            _emit(f"Modell aus Original-Checkpoint geladen ({time.monotonic() - started:.1f}s)")
        except Exception as e:
            _emit(f"Fehler: NER-Modell konnte nicht geladen werden: {e}")
            _emit("Führen Sie scripts/setup-ner.sh --model aus, um das Modell herunterzuladen.")
            sys.exit(2)

        _write_fast_checkpoint(tagger, fast_path)

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
        # Fenster-Settings zählen. Das ist eine NÄHERUNG der echten
        # Padding-Matrix, keine Kopie: flair tokenisiert intern über die
        # Wortliste (is_split_into_words=True) und hängt als FLERT-Modell
        # ±64 Wörter Kontext der Nachbarn an — beides macht die echten Zeilen
        # etwas LÄNGER als hier gezählt. Deshalb ist ein OOM trotz Budget
        # möglich; die adaptive Halbierung unten fängt das ab. emb.* sind
        # flair-Interna (Version in requirements-ner.txt auf <0.16 begrenzt) —
        # verschiebt eine künftige Version die Attribute, schätzen wir aus der
        # Textlänge weiter (estimate_item überschätzt bewusst), statt hier zu
        # sterben: ein AttributeError würde sonst JEDE Anonymisierung nach
        # error kippen.
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
            _emit(f"Token-Zählung nicht möglich ({count_error}) — schätze aus Textlänge")
            items = [estimate_item(text) for text, _ in indexed_texts]

        def build_sentences():
            """
            Alle Sentences neu erzeugen und dokumentweit verketten.

            Die Verkettung ist der Grund, warum das hier EINMAL für das ganze
            Transkript passiert und nicht pro Gruppe: flair/ner-german-large
            ist ein FLERT-Modell (context_length 64) und zieht Kontext aus
            `_previous_sentence`/`_next_sentence`. `predict()` ruft selbst
            `Sentence.set_context_for_sentences()` über die ÜBERGEBENE Liste
            auf — verkettete also nur Gruppen-Nachbarn und liesse ein Segment,
            das allein in seiner Gruppe landet, ohne jeden Kontext. Da
            set_context_for_sentences bereits verkettete Sentences überspringt
            (`if sentence.is_context_set(): continue`), bleibt eine hier
            gesetzte Dokumentkette erhalten: die Erkennungsqualität hängt
            damit nicht mehr an der Batch-Gruppierung. Gemessen speicherneutral
            (3.16 GiB mit und ohne, auch bei durchgehenden Singleton-Gruppen).

            Wird nach einem abgebrochenen Forward-Pass erneut gerufen: der
            Abbruch kann halb-annotierte Objekte hinterlassen.
            """
            fresh = [Sentence(text) for text, _ in indexed_texts]
            Sentence.set_context_for_sentences(fresh)
            return fresh

        def on_mps():
            return flair.device.type == "mps"

        sentences = build_sentences()

        # Adaptive Batch-Grösse: ein MPS-OOM heisst, dass das Budget für DIESE
        # Maschine zu hoch war (die Zählung oben unterschätzt, und das Ceiling
        # ist 1.7 × ⅔ × RAM — auf 8 GB nur 9.07 GiB). Dann wird das Budget
        # halbiert und der Rest neu gepackt, statt sofort auf CPU zu gehen:
        # MPS bleibt 3–5× schneller, und der Lauf bleibt unter dem harten
        # 900-s-Timeout in AnonymizationService.ts. Erst wenn eine Gruppe
        # nicht mehr teilbar ist (ein einzelnes übergrosses Segment), geht
        # genau diese auf CPU — dort gibt es kein Ceiling.
        budget = TOKEN_BUDGET
        done = 0
        start = 0

        while start < len(indexed_texts):
            # `base` bleibt für diese Packung fix — `start` wandert innerhalb der
            # for-Schleife weiter (damit ein `break` beim Neu-Packen an der
            # richtigen Stelle fortsetzt), taugt deshalb NICHT als Offset-Basis.
            base = start
            groups = pack_by_budget(items[base:], budget)
            repacked = False

            for local_group in groups:
                group = [base + j for j in local_group]
                group_rows = sum(items[i][0] for i in group)
                group_padded = max(items[i][1] for i in group)
                # Format ist ein Contract: scripts/smoke-packaged.sh prüft
                # daraus, dass keine Gruppe das Budget überschreitet.
                _emit(
                    f"[BATCH] sentences={len(group)} rows={group_rows} "
                    f"padded={group_padded} budget={budget}"
                )

                try:
                    tagger.predict(
                        [sentences[i] for i in group], mini_batch_size=len(group)
                    )
                except RuntimeError as e:
                    if not (on_mps() and "out of memory" in str(e).lower()):
                        raise

                    if len(group) > 1 and budget > MIN_TOKEN_BUDGET:
                        budget //= 2
                        _emit(
                            f"MPS out of memory — halbiere Token-Budget auf {budget} "
                            "und packe die verbleibenden Segmente neu"
                        )
                        sentences = build_sentences()
                        repacked = True
                        break

                    _emit(
                        "MPS out of memory bei einem unteilbaren Segment — "
                        "wechsle auf CPU"
                    )
                    flair.device = torch.device("cpu")
                    tagger.to(flair.device)
                    try:
                        torch.mps.empty_cache()
                    except Exception as cache_error:  # noqa: BLE001 — best effort
                        _emit(f"torch.mps.empty_cache() fehlgeschlagen: {cache_error}")
                    sentences = build_sentences()
                    tagger.predict(
                        [sentences[i] for i in group], mini_batch_size=len(group)
                    )

                for i in group:
                    idx = indexed_texts[i][1]
                    for entity in sentences[i].get_spans("ner"):
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
                start += len(group)
                pct = 25 + int(done / max(1, len(indexed_texts)) * 70)
                report_progress(min(pct, 95))

            if not repacked and start < len(indexed_texts):
                # Verteidigung gegen eine Endlosschleife: pack_by_budget gibt
                # für nicht-leere items immer mindestens eine Gruppe zurück,
                # jede Gruppe schiebt `start` weiter. Käme das doch nicht
                # voran, ist ein harter Fehler besser als ein Hänger bis zum
                # 900-s-Timeout.
                raise RuntimeError(
                    f"Batch-Packing kommt nicht voran (start={start}, budget={budget})"
                )

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
