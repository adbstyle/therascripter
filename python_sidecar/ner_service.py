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
        {"text": "Dr. Müller", "type": "PER", "segmentIndex": 0,
         "charStart": 0, "charEnd": 10, "confidence": 0.96}
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
import warnings
import zipfile
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


NER_MODEL_ID = "flair/ner-german-large"

# Nur für Messwerkzeuge (scripts/ner-parity.py): "cpu" erzwingt einen
# fp32-Referenzlauf auf der CPU aus dem Original-Checkpoint — ohne die Fast-Kopie
# zu lesen oder zu schreiben (siehe _load_tagger). Die App setzt die Variable
# nie — Subprozesse bekommen eine Whitelist-Env (subprocess.ts).
DEVICE_OVERRIDE_ENV = "THERASCRIPT_NER_DEVICE"

# Namenskonvention der Fast-Kopie (siehe needs_fast_checkpoint). Aufräumen fasst
# ausschliesslich Dateien mit diesem Suffix an, nie das Original.
FAST_CHECKPOINT_SUFFIX = "-fast.pt"

# Die Fast-Kopie eines v1/v2-Originals belegt zusätzliche ~1.1 GB (fp16 auf
# MPS, siehe _write_fast_checkpoint) bzw. ~2.1 GB (fp32 auf der CPU). Unter diesem
# Schwellwert wird nicht konvertiert, damit das Modellverzeichnis auf knappen
# Platten nicht volläuft.
FAST_CHECKPOINT_MIN_FREE_BYTES = 3 * 1024**3


def fast_checkpoint_name(model_id):
    """
    Dateiname des konvertierten Checkpoints — abgeleitet aus der Modell-ID.

    Das Modellverzeichnis heisst nach der GRUPPE ("ner"), nicht nach dem Modell:
    ein zweites NER-Modell (der Slot activeModels.ner existiert bereits, NFR-9/10
    fordert Austauschbarkeit) würde denselben Ordner benutzen. Stünde hier ein
    fester Name, läde der Fast-Pfad die Kopie des deutschen Modells auch dann,
    wenn ein anderes aktiv ist — still und ohne Fehler. Über die ID im Namen
    greift der Fast-Pfad bei einem Modellwechsel schlicht nicht mehr und der
    Lauf konvertiert neu.
    """
    return model_id.replace("/", "--") + FAST_CHECKPOINT_SUFFIX


def should_write_fast_checkpoint(path, free_bytes, source_bytes):
    """
    Entscheidet, ob der konvertierte Checkpoint geschrieben werden soll.

    Reine Funktion ohne Dateisystem-Zugriff, damit sie testbar ist — die Frage
    "existiert die Datei schon?" beantwortet der Aufrufer. Geschrieben wird,
    wenn ein Pfad vorliegt UND nach dem Schreiben noch der Puffer aus
    FAST_CHECKPOINT_MIN_FREE_BYTES übrig bleibt. Fehlt der Platz, läuft alles
    weiter wie bisher — nur eben mit dem langsameren Load des Originals.
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


LOW_RAM_BYTES = 8 * 1024**3
LOW_RAM_MAX_SENTENCES_PER_BATCH = 8


def max_sentences_for_ram(ram_bytes):
    """
    Segment-Deckel pro Mini-Batch für eine Maschine mit `ram_bytes` RAM.

    Das Token-Budget zählt nur die Segment-Tokens. flair hängt als FLERT-Modell
    aber jedem Segment ±64 Wörter Nachbar-Kontext an — bei kurzen
    Audio-Segmenten ist der Forward-Pass dadurch ein Mehrfaches grösser als
    gezählt, und der Segment-Deckel bestimmt die echte Grösse der Batch.
    Gemessen (45-min-Podcast, fp16 auf MPS): 4.75 GiB Prozess-Peak bei 32
    Segmenten, 3.46 GiB bei 8 — für ~20 % mehr Inferenzzeit. Auf 8-GB-Macs ist
    diese Differenz der Abstand zum Swap, auf grösseren Macs nur verschenkte
    Zeit.

    Unbekannter RAM (None/0) zählt als knapp: der Preis ist nur Laufzeit.
    """
    if not ram_bytes or ram_bytes <= LOW_RAM_BYTES:
        return LOW_RAM_MAX_SENTENCES_PER_BATCH
    return MAX_SENTENCES_PER_BATCH


def physical_ram_bytes():
    """Physischer RAM in Bytes, None wenn nicht ermittelbar."""
    try:
        return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
    except (ValueError, OSError):
        return None


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


def _remove_fast_checkpoints(directory, keep=None):
    """
    Nicht (mehr) benötigte Fast-Checkpoints aus dem Verzeichnis räumen.

    - Kopien anderer Modelle: das Verzeichnis gehört der Gruppe, nicht dem
      Modell; nach einem Modellwechsel bliebe die bis zu ~2.1 GB grosse Kopie des
      alten Modells sonst für immer liegen.
    - Ohne `keep` (Dateiname) alle Kopien: der Fall eines kompakten Originals
      (Artefakt v3), neben dem v0.8.10 noch eine Kopie angelegt hat.
    - Halbe .tmp-Dateien eines Laufs, der beim Schreiben per SIGKILL endete
      (Watchdog, 900-s-Wall): der nächste Lauf hat eine andere PID und würde
      sie nie überschreiben. Eine .tmp, die ein parallel laufender Prozess
      gerade schreibt, darf mit weg — dessen os.replace scheitert dann, und das
      ist folgenlos (siehe _write_fast_checkpoint).

    Nie fatal: Aufräumen ist Hygiene, ein Fehler darf den Lauf nicht beenden.
    """
    try:
        names = os.listdir(directory)
    except OSError as e:
        _emit(f"Modellverzeichnis nicht lesbar, überspringe Aufräumen: {e}")
        return
    for name in names:
        is_copy = name.endswith(FAST_CHECKPOINT_SUFFIX)
        is_orphan = FAST_CHECKPOINT_SUFFIX + "." in name and name.endswith(".tmp")
        if not (is_copy or is_orphan) or name == keep:
            continue
        try:
            os.remove(os.path.join(directory, name))
            _emit(f"Nicht mehr benötigten Fast-Checkpoint entfernt: {name}")
        except OSError as e:
            _emit(f"Fast-Checkpoint {name} liess sich nicht entfernen: {e}")


def _write_fast_checkpoint(tagger, fast_path):
    """
    Den geladenen Tagger einmalig im aktuellen flair-Layout ablegen (Fast-Kopie).

    Atomar über eine temporäre Datei plus os.replace: ein Abbruch mitten im
    Schreiben (SIGKILL, volle Platte) darf keinen halben Checkpoint
    hinterlassen, den der nächste Lauf für gültig hält. Jeder Fehler ist
    folgenlos — der nächste Lauf nimmt wieder den Original-Pfad.
    """
    directory = os.path.dirname(fast_path)
    tmp_path = f"{fast_path}.{os.getpid()}.tmp"
    try:
        # Vor der Platzmessung: Waisen und fremde Kopien geben Platz frei.
        _remove_fast_checkpoints(directory, keep=os.path.basename(fast_path))
        free_bytes = shutil.disk_usage(directory).free
        # Zielgrösse aus dem geladenen Modell statt einer Konstante: Anzahl
        # Gewichte mal Bytes pro Gewicht, und tagger.save() schreibt genau
        # diesen In-Memory-Stand. Auf MPS ist das fp16 (_half_precision_on) —
        # die Kopie eines v1/v2-Originals entspricht dann dem v3-Artefakt
        # (1.1 statt 2.2 GB); nur auf der CPU entsteht sie als fp32.
        source_bytes = sum(p.numel() * p.element_size() for p in tagger.parameters())
        if not should_write_fast_checkpoint(fast_path, free_bytes, source_bytes):
            _emit(
                "Zu wenig freier Speicher für den schnellen Checkpoint — "
                f"{free_bytes / 1024**3:.1f} GB frei, "
                f"{source_bytes / 1024**3:.1f} GB nötig, überspringe Konvertierung"
            )
            return
        # PID im Namen: smoke-packaged.sh und manuelle Aufrufe können parallel
        # zu einem App-Task laufen; zwei Prozesse auf derselben .tmp würden ihre
        # Schreibvorgänge verschränken und das Ergebnis per os.replace als
        # gültigen Checkpoint scharf schalten.
        started = time.monotonic()
        tagger.save(tmp_path)
        os.replace(tmp_path, fast_path)
        _emit(
            "Schneller Checkpoint geschrieben "
            f"({time.monotonic() - started:.1f}s) — nächster Lauf lädt schneller"
        )
    except Exception as e:  # noqa: BLE001 — reine Optimierung, nie fatal
        _emit(f"Schneller Checkpoint konnte nicht geschrieben werden: {e}")
        _remove_silently(tmp_path)


def is_zip_checkpoint(path):
    """
    True, wenn `path` ein Checkpoint im modernen (Zip-)Format von torch.save ist.

    Gleiches Kriterium wie torch.serialization._is_zipfile: die Signatur am
    Dateianfang. zipfile.is_zipfile wäre zu lax — es sucht die Signatur auch im
    Dateiende und schlägt damit auf beliebigen Binärdaten an.
    """
    try:
        with open(path, "rb") as f:
            return f.read(4) == b"PK\x03\x04"
    except OSError:
        return False


def needs_fast_checkpoint(path):
    """
    True, wenn der Original-Checkpoint von einer Fast-Kopie profitiert.

    Zwei Generationen des Originals liegen bei Usern — beide im Zip-Format, das
    alte Pickle-Format war nie die Ursache der Ladezeit:

    - Artefakt v1/v2: so, wie HuggingFace ihn liefert — fp32, gespeichert von
      einer alten flair-Version, die die Embeddings als OBJEKT mitpickelt
      (TransformerWordEmbeddings samt Gewichten). Schon torch.load baut dabei
      das komplette Transformer-Modell auf (gemessen 8.2 s), danach baut flair
      es für den Tagger ein zweites Mal — 14–18 s gesamt. Eine einmal mit dem
      aktuellen flair neu gespeicherte Kopie (tagger.save: Embeddings nur als
      Param-Dict) lädt in ~8 s.
    - Artefakt v3 (Issue #131): von scripts/convert-ner-fp16.py bereits in
      diesem Layout UND als fp16 an die Stelle des Originals geschrieben. Auf
      MPS wird er unverändert als fp16 geladen, auf der CPU castet
      load_state_dict in frisch gebaute fp32-Parameter hoch. Eine Kopie
      brächte hier nichts.

    Unterschieden wird ohne Laden an den Klassenreferenzen in data.pkl (bei
    beiden Varianten nur 0.1–17 MB). Im Zweifel True: eine überflüssige Kopie
    kostet nur Platz, eine fehlende bei v1/v2 dagegen jeden Lauf ~8 s.
    """
    if not path:
        return True
    try:
        with zipfile.ZipFile(path) as archive:
            pickle_name = next(n for n in archive.namelist() if n.endswith("/data.pkl"))
            return b"flair.embeddings" in archive.read(pickle_name)
    except (OSError, StopIteration, zipfile.BadZipFile):
        return True


def _remove_silently(path):
    try:
        os.remove(path)
    except OSError:
        pass


def _resolve_original_checkpoint(model_id):
    """Pfad des Original-Checkpoints im flair-Cache, None wenn nicht auflösbar."""
    try:
        from flair.file_utils import hf_download

        return hf_download(model_id)
    except Exception:  # noqa: BLE001 — Auflösung ist nur ein Hinweis, der Load entscheidet
        return None


def _install_mmap_loader():
    """
    flairs Checkpoint-Loader durch eine mmap-fähige Variante ersetzen.

    flair ruft torch.load mit einem FILE-OBJEKT auf (flair/file_utils.py:
    load_torch_state) — damit ist mmap nicht möglich, torch verlangt dafür einen
    Pfad. mmap funktioniert laut torch-Doku nur mit dem Zip-Format; alles andere
    geht unverändert durch flairs eigenen Loader. Scheitert mmap selbst (z. B.
    ENOMEM unter Speicherdruck, ein Volume ohne mmap-Support), lädt derselbe
    Aufruf ohne mmap nach — sonst scheiterte der Fallback aufs Original aus
    demselben Grund wie die Fast-Kopie, und die Session landete in 'error'.
    Damit kann der Patch für jeden Load aktiv bleiben.
    flair.nn.model importiert den Namen direkt, deshalb muss er an BEIDEN
    Stellen ersetzt werden.
    """
    import flair.file_utils
    import flair.nn.model
    import torch

    flair_loader = flair.file_utils.load_torch_state

    def load_torch_state(model_file):
        if is_zip_checkpoint(model_file):
            try:
                with warnings.catch_warnings():
                    warnings.filterwarnings("ignore")
                    return torch.load(
                        model_file, map_location="cpu", weights_only=False, mmap=True
                    )
            except Exception as e:  # noqa: BLE001 — mmap ist nur Beschleunigung
                _emit(f"mmap-Load fehlgeschlagen ({e}) — lade ohne mmap")
        return flair_loader(model_file)

    flair.file_utils.load_torch_state = load_torch_state
    flair.nn.model.load_torch_state = load_torch_state


def _load_tagger(model_dir, Classifier):
    """
    Den Tagger laden — aus dem Original oder seiner Fast-Kopie (siehe
    needs_fast_checkpoint). Die Kopie ist reine Beschleunigung: schlägt ihr Load
    fehl, wird sie verworfen und das Original geladen, damit ein korrupter
    Checkpoint die Anonymisierung nie blockiert. Exit 2, wenn auch das scheitert.

    Die Zeilen "Modell aus … geladen (Xs)" und "Original-Checkpoint ist kompakt"
    sind ein Contract mit scripts/ner-parity.py bzw. smoke-packaged.sh.
    """
    _install_mmap_loader()
    fast_path = os.path.join(model_dir, fast_checkpoint_name(NER_MODEL_ID))
    wants_fast_copy = needs_fast_checkpoint(_resolve_original_checkpoint(NER_MODEL_ID))
    # Referenzlauf (DEVICE_OVERRIDE_ENV): die Fast-Kopie eines v1/v2-Originals
    # ist seit der fp16-Inferenz selbst fp16 — gelesen, rechnete die
    # fp32-Referenz mit gerundeten Gewichten; geschrieben, legte sie eine
    # 2.1-GB-fp32-Kopie ins Modellverzeichnis des Users.
    reference_run = os.environ.get(DEVICE_OVERRIDE_ENV) == "cpu"

    if reference_run:
        _emit("Referenzlauf — lade das Original, Fast-Kopie bleibt unberührt")
        wants_fast_copy = False
    elif not wants_fast_copy:
        _emit("Original-Checkpoint ist kompakt — keine Fast-Kopie nötig")
        _remove_fast_checkpoints(model_dir)
    elif os.path.isfile(fast_path):
        try:
            return _timed_load(Classifier, fast_path, "konvertiertem Checkpoint")
        except Exception as fast_error:  # noqa: BLE001 — Fast-Pfad ist optional
            _emit(f"Konvertierter Checkpoint unbrauchbar ({fast_error}) — nutze Original")
            _remove_silently(fast_path)

    try:
        tagger = _timed_load(Classifier, NER_MODEL_ID, "Original-Checkpoint")
    except Exception as e:
        _emit(f"Fehler: NER-Modell konnte nicht geladen werden: {e}")
        _emit("Führen Sie scripts/setup-ner.sh --model aus, um das Modell herunterzuladen.")
        sys.exit(2)

    if wants_fast_copy:
        _write_fast_checkpoint(tagger, fast_path)
    return tagger


@contextmanager
def _half_precision_on(device):
    """
    Den Tagger direkt als fp16 auf `device` bauen — nur auf MPS.

    flair baut XLM-R über AutoModel.from_config im Default-dtype auf dem
    Default-Device: also zuerst 2.24 GB zufällige fp32-Gewichte auf der CPU,
    in die load_state_dict den Checkpoint kopiert, danach legt
    `model.to(flair.device)` eine ZWEITE Kopie auf der GPU an. Mit fp16 als
    Default-dtype und MPS als Default-Device entsteht das Modell gleich in
    seiner Endform (1.12 GB, keine CPU-Kopie) — gemessen sinkt der Lade-Peak
    von 5.16 auf 1.87 GiB, die Ladezeit von 6 auf 0.6 s. Auch die Inferenz
    läuft damit in fp16 (Inferenz-Peak 45-min-Audio 9.40 → 7.10 GiB). Parität
    gegen fp32: identische Spans und Typen auf allen drei Mess-Eingaben
    (277/277, 93/93, 419/419), maximale Konfidenz-Abweichung 0.014.

    Nicht auf der CPU: fp16-Matmuls sind dort langsam, und der Speicher ist
    dort nicht das Problem (siehe CPU-Fallback in run_ner, der auf fp32
    zurückcastet). torch dokumentiert set_default_dtype nur für fp32/fp64;
    fp16 funktioniert für den Modellbau, ist aber globaler Zustand — deshalb
    strikt auf den Load begrenzt und im finally zurückgesetzt.
    """
    import torch

    if device.type != "mps":
        yield
        return

    previous = torch.get_default_dtype()
    torch.set_default_dtype(torch.float16)
    try:
        with device:
            yield
    finally:
        torch.set_default_dtype(previous)


def _release_mps_cache():
    """
    Den Cache des MPS-Allokators an das System zurückgeben.

    Der Allokator behält freigegebene Blöcke für spätere Allokationen;
    gemessen hielt er nach einem 45-min-Transkript 6.4 GiB (fp16), die kein
    Forward-Pass mehr brauchte. Seine eigene Aufräum-Schwelle (Low-Watermark,
    1.4 × ⅔ × RAM) liegt auf 8-GB-Macs bei ~7.5 GiB — der Cache wächst dort
    also in den Swap, bevor sie greift. Nach jeder Gruppe geleert:
    Prozess-Peak 7.10 → 4.75 GiB, Laufzeit unverändert. Ohne MPS ein No-op.
    """
    import torch

    if not torch.backends.mps.is_available():
        return
    try:
        torch.mps.empty_cache()
    except Exception as cache_error:  # noqa: BLE001 — best effort
        _emit(f"torch.mps.empty_cache() fehlgeschlagen: {cache_error}")


def _timed_load(Classifier, source, label):
    import flair

    started = time.monotonic()
    with _half_precision_on(flair.device):
        tagger = Classifier.load(source)
    _emit(f"Modell aus {label} geladen ({time.monotonic() - started:.1f}s)")
    return tagger


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

        if os.environ.get(DEVICE_OVERRIDE_ENV) == "cpu":
            _emit(f"{DEVICE_OVERRIDE_ENV}=cpu — nutze CPU (fp32-Referenz)")
        elif torch.backends.mps.is_available():
            flair.device = torch.device("mps")
            _emit("MPS-Backend aktiv (Apple Silicon GPU)")
    except Exception as e:
        _emit(f"MPS nicht verfügbar, nutze CPU: {e}")

    tagger = _load_tagger(model_dir, Classifier)

    # Contract mit smoke-packaged.sh (Check 'ner precision'): mit MPS muss hier
    # torch.float16 stehen, sonst ist der Speicher-Fix still verloren. Bewusst
    # NACH _load_tagger statt in _timed_load: dort zählte jeder Fehler als
    # unbrauchbare Fast-Kopie und löschte sie.
    weights = next(tagger.parameters())
    _emit(f"Gewichte: {weights.dtype} auf {weights.device}")

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

        max_sentences = max_sentences_for_ram(physical_ram_bytes())

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
            groups = pack_by_budget(items[base:], budget, max_sentences)
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

                # Die Reaktion auf ein OOM läuft bewusst NACH dem except-Block:
                # solange er aktiv ist, hält die Exception über ihren Traceback
                # die Aktivierungen des gescheiterten Passes auf der GPU fest —
                # empty_cache() gäbe nichts frei, und der CPU-Lauf liefe neben
                # diesem toten Speicher her.
                oom = False
                try:
                    tagger.predict(
                        [sentences[i] for i in group], mini_batch_size=len(group)
                    )
                except RuntimeError as e:
                    if not (on_mps() and "out of memory" in str(e).lower()):
                        raise
                    oom = True

                _release_mps_cache()

                if oom and len(group) > 1 and budget > MIN_TOKEN_BUDGET:
                    budget //= 2
                    _emit(
                        f"MPS out of memory — halbiere Token-Budget auf {budget} "
                        "und packe die verbleibenden Segmente neu"
                    )
                    sentences = build_sentences()
                    repacked = True
                    break

                if oom:
                    _emit(
                        "MPS out of memory bei einem unteilbaren Segment — "
                        "wechsle auf CPU"
                    )
                    flair.device = torch.device("cpu")
                    # Zurück auf fp32: auf der CPU ist fp16 langsam (siehe
                    # _half_precision_on), und hier zählt nur noch, unter dem
                    # 900-s-Timeout fertig zu werden. Erst verschieben, DANN
                    # casten: `to(cpu, float32)` castet auf der GPU und braucht
                    # dort neuen Speicher — genau der fehlt hier (gemessen:
                    # Exit 3 statt CPU-Lauf bei knappem MPS-Limit).
                    tagger.to(flair.device)
                    tagger.float()
                    _release_mps_cache()
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
                "model": NER_MODEL_ID,
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
            "model": NER_MODEL_ID,
            "segmentCount": len(segments),
            "entityCount": len(all_entities),
        },
    }

    print(json.dumps(result, ensure_ascii=False))
    report_progress(100)


if __name__ == "__main__":
    main()
