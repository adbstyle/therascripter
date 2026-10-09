#!/usr/bin/env python3
"""
Speaker diarization service using pyannote.audio.

Processes an audio file and outputs speaker segments in RTTM format to stdout.
Progress is reported to stderr for parsing by the Electron main process.

Usage:
    python3 diarize.py --audio <path> --hf-model <hf-pipeline-identifier>
                       [--model-dir <path>] [--min-speakers 1] [--max-speakers 4]
                       [--collar 0.5]

Output format (RTTM, one line per speaker segment):
    SPEAKER <file-id> 1 <start-sec> <duration-sec> <NA> <NA> <speaker-label> <NA> <NA>

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
import os
import sys
import threading
from contextlib import contextmanager

# CSP-Äquivalent: Alle HuggingFace-Hub-Netzwerk-Requests blockieren.
# CSP connect-src 'none' gilt nur im Electron-Renderer, nicht im Python-Subprocess.
# Ohne diese Flags könnte pyannote/huggingface-hub Sub-Models bei fehlendem lokalen
# Cache stillschweigend über HTTP nachziehen. Muss gesetzt werden, BEVOR pyannote
# importiert wird (oben im File, nicht in main()).
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")


HEARTBEAT_INTERVAL_SEC = 10

# Blocklänge beim Laden der Waveform (load_waveform). Bestimmt nur den
# Zwischenspeicher pro Block (dominiert vom im2col-Puffer des Resamplers,
# ≈ 0.2 GB bei 60 s), nicht das Ergebnis.
BLOCK_SECONDS = 60

# Obergrenze fürs Warten auf _stderr_lock. Siehe _emit: der Lock ist eine
# Best-Effort-Garantie für Zeilenintegrität, nie eine Vorbedingung fürs
# Schreiben — deshalb ein Timeout statt eines blockierenden `with`.
_STDERR_LOCK_TIMEOUT_SEC = 2

_stderr_lock = threading.Lock()

# _emit/heartbeat sind absichtlich deckungsgleich mit ner_service.py statt in
# einem gemeinsamen Modul: beide Scripts werden einzeln nach
# Contents/Resources/ml_sidecar/ kopiert (electron-builder.yml). Ein geteiltes
# Modul bräuchte einen weiteren Copy-Eintrag und würde bei jedem vergessenen
# Bundling-Schritt zu einem ImportError auf dem Endnutzer-Mac.


def _emit(line: str) -> None:
    """
    Eine Zeile in EINEM write() auf stderr schreiben.

    Alle stderr-Ausgaben dieses Scripts laufen hier durch. Grund: print()
    macht zwei write()-Calls (Text, dann Newline); der Heartbeat-Thread und
    der Haupt-Thread würden sich sonst mitten in einer Zeile verschränken und
    der [PROGRESS]-Parser im Main-Prozess bekäme Müll.

    Der Lock wird mit Timeout genommen und im Zweifel übersprungen: er darf
    niemals blockieren. thread.join(timeout=1) in heartbeat() kann den
    Heartbeat-Thread aufgeben, während der in einem hängenden flush() steckt
    und den Lock hält — ein blockierendes `with` würde dann den Haupt-Thread
    beim nächsten report_progress() für immer aufhalten, obwohl das Ergebnis
    schon auf stdout steht. Eine im Extremfall verschränkte Diagnosezeile ist
    der bessere Preis.
    """
    acquired = _stderr_lock.acquire(timeout=_STDERR_LOCK_TIMEOUT_SEC)
    try:
        sys.stderr.write(line + "\n")
        sys.stderr.flush()
    finally:
        if acquired:
            _stderr_lock.release()


def report_progress(percent: int) -> None:
    """Print progress to stderr for TaskExecutor parsing."""
    _emit(f"[PROGRESS] {percent}")


@contextmanager
def heartbeat():
    """
    Daemon-Thread, der alle HEARTBEAT_INTERVAL_SEC ein Lebenszeichen auf
    stderr schreibt.

    Der ProcessWatchdog im Main-Prozess kennt nur [PROGRESS] als Lebenszeichen.
    Zwischen [PROGRESS] 5 (nach `from pyannote.audio import Pipeline`) und
    [PROGRESS] 20 (nach Pipeline.from_pretrained) liegt aber der Load von
    Segmentation- und Embedding-Checkpoint plus der torch-Import: auf einer
    Maschine mit wenig freiem RAM ist das überwiegend I/O-Wait und kann die
    Stall-Schwelle (min. 120 s) reissen — der Watchdog würde einen gesunden
    Prozess mitten im Modell-Load killen. Dieselbe Ursache wie in
    ner_service.py, nur mit kleinerem Checkpoint.

    Auch danach bleiben Lücken: load_waveform() dekodiert und resampelt das
    Audio, bevor der ProgressHook das erste Mal feuert.
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


def _attr_path(obj, *names):
    """getattr-Kette, die bei einem fehlenden Glied None liefert statt zu werfen."""
    for name in names:
        obj = getattr(obj, name, None)
    return obj


def load_waveform(path: str, sample_rate: int):
    """
    Audiodatei EINMAL laden, auf Mono mischen und auf `sample_rate` bringen.

    Ergebnis ist ein (1, time)-float32-Tensor für pyannotes In-Memory-Eingabe
    {"waveform": …, "sample_rate": …}. Mit einem Dateipfad schneidet pyannote
    jeden Embedding-Chunk (10-s-Fenster, Schritt 1 s → ~3000 bei 50 min)
    einzeln von der Platte — über den torchcodec-Shim heisst das pro Chunk
    sf.info + Seek + Read + Resampling 48 → 16 kHz, seriell vor der
    MPS-Inferenz. Aus dem Speicher ist ein Crop reines Slicing.

    Die Waveform muss bereits in der Ziel-Rate übergeben werden: Audio.crop
    ruft auch im In-Memory-Zweig downmix_and_resample auf und würde eine
    48-kHz-Waveform weiterhin pro Chunk resampeln. Resampelt wird mit derselben
    Funktion, die pyannote intern nutzt.

    Gelesen und resampelt wird blockweise in den vorallokierten Ziel-Tensor.
    NIE am Stück: torchaudios conv1d entfaltet die ganze Waveform (im2col,
    Faktor ≈ Kernel-Länge 41 bei 48 → 16 kHz) — gemessen 19 GiB Zuwachs für
    eine 2-h-Aufnahme statt 0.6 GiB blockweise, auf 8-GB-Macs tödlich.
    Ergebnis wie am Stück: torchaudio rechnet pro Conv-Frame `orig` Eingangs-
    auf `new` Ausgangssamples (nach GCD-Kürzung), deshalb beginnen Blöcke auf
    Frame-Grenzen und lesen links und rechts `context` Samples Nachbarschaft
    mit, die mindestens die Kernel-Breite abdeckt. Die Randframes jedes Blocks,
    die torchaudios Null-Padding sehen, werden verworfen; nur am Dateianfang
    und -ende bleibt es — wie am Stück. Abweichungen gegenüber am Stück: Float-
    Rundung der BLAS-Reduktion (≤ 1 ULP) und ggf. ein Sample mehr am Ende
    (torchaudio rechnet die Ziel-Länge in float32). smoke-packaged.sh (Check
    `diarize waveform blocks`) vergleicht beides über mehrere Blockgrenzen.
    """
    import math

    import soundfile as sf
    import torch
    import torchaudio.transforms

    with sf.SoundFile(path) as audio_file:
        file_sample_rate = audio_file.samplerate
        n_in = audio_file.frames
        gcd = math.gcd(file_sample_rate, sample_rate)
        orig = file_sample_rate // gcd
        new = sample_rate // gcd
        if file_sample_rate != sample_rate:
            # Einmal gebaut statt pro Block: functional.resample baut den
            # Sinc-Kernel bei jedem Aufruf neu. Filter-Defaults wie in pyannotes
            # downmix_and_resample; dtype float32, weil functional.resample den
            # Kernel in der dtype der Waveform baut (ohne dtype rechnete die
            # Transform in float64 — gemessen 3x grössere Abweichung).
            resampler = torchaudio.transforms.Resample(
                file_sample_rate, sample_rate, dtype=torch.float32
            )
            # Kontext aus der Halbbreite des tatsächlich gebauten Kernels statt
            # aus einer nachgebauten Formel — sonst entstünden nach einer
            # Änderung der torchaudio-Defaults still Artefakte an jeder
            # Blockgrenze. torchaudio paddet (width, width + orig); auf
            # Frame-Grenzen gerundet, damit `skip` ganzzahlig bleibt.
            context = math.ceil((resampler.width + orig) / orig) * orig
        else:
            resampler = None
            context = 0
        n_out = math.ceil(new * n_in / orig)
        step = max(1, (file_sample_rate * BLOCK_SECONDS) // orig) * orig

        waveform = torch.empty(1, n_out, dtype=torch.float32)
        written = 0
        for start in range(0, n_in, step):
            lo = max(0, start - context)
            hi = min(n_in, start + step + context)
            audio_file.seek(lo)
            data = audio_file.read(hi - lo, dtype="float32", always_2d=True)
            # soundfile liefert (frames, channels), pyannote erwartet (channel, time).
            block = torch.from_numpy(data.T)
            if block.shape[0] > 1:
                block = block.mean(dim=0, keepdim=True)
            if resampler is not None:
                block = resampler(block)
            out_start = start // orig * new
            out_end = min(n_out, (start + step) // orig * new)
            skip = (start - lo) // orig * new
            chunk = block[:, skip : skip + out_end - out_start]
            # Nur der letzte Block darf kürzer sein: torchaudio rechnet die
            # Ziel-Länge in float32 und liefert dort ggf. ein Sample weniger
            # als ceil(new * n / orig). Mitten in der Datei bliebe eine Lücke
            # aus torch.empty-Müll stehen — lieber scheitern (Exit 3) als auf
            # korruptem Audio diarisieren.
            if chunk.shape[1] < out_end - out_start and start + step < n_in:
                raise RuntimeError(
                    f"Resampling-Block bei Sample {start} zu kurz: "
                    f"{chunk.shape[1]} statt {out_end - out_start} Samples"
                )
            waveform[:, out_start : out_start + chunk.shape[1]] = chunk
            written = out_start + chunk.shape[1]
    return waveform[:, :written]


def run_diarization(args):
    """
    Import, Modell-Load, Inferenz und Collar-Postprocessing.

    Ausgelagert, damit main() den ganzen Block in `with heartbeat():` fassen
    kann — das sind die Phasen, in denen minutenlang kein [PROGRESS] fällt.
    Gibt die fertige pyannote-Annotation zurück; nur noch die RTTM-Ausgabe
    (reine String-Formatierung) passiert danach.
    """
    # Import pyannote (heavy import, ~2-3s)
    try:
        from pyannote.audio import Pipeline
        import torch
    except ImportError as e:
        _emit(f"Fehler: Benötigtes Paket nicht installiert: {e}")
        _emit("Führen Sie scripts/setup-pyannote.sh aus, um Abhängigkeiten zu installieren.")
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
        _emit(f"Fehler: Pyannote-Modell konnte nicht geladen werden: {e}")
        _emit(f"Modellverzeichnis: {args.model_dir}")
        _emit("Führen Sie scripts/setup-pyannote.sh --model aus, um das Modell herunterzuladen.")
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

        # Ziel-Rate ist die des Embedding-Modells (pyannote croppt die
        # Embedding-Chunks über pipeline._audio). Die Segmentierung muss
        # dieselbe Rate haben, sonst resampelt ihr Inference.__call__ die
        # vorgeladene Waveform am Stück — genau die im2col-Spitze, die
        # load_waveform vermeidet. Fehlt ein Attribut (pyannote-Interna
        # verschoben) oder weichen die Raten ab, bleibt es beim Dateipfad:
        # korrekt, aber mit der alten Speicherspitze (gemessen 5.4–8.4 GB bei
        # 28–45 min, auf 8-GB-Macs OOM-gefährdet) und Chunk-Reads von der
        # Platte. Beide Zweige melden sich auf stderr: smoke-packaged.sh
        # assertet auf die Preload-Zeile, damit ein solcher Rückfall das
        # Release-Gate nicht grün passiert.
        sample_rate = _attr_path(pipeline, "_audio", "sample_rate")
        segmentation_rate = _attr_path(pipeline, "_segmentation", "model", "audio", "sample_rate")
        if sample_rate and sample_rate == segmentation_rate:
            audio_input = {
                "waveform": load_waveform(args.audio, sample_rate),
                "sample_rate": sample_rate,
            }
            _emit(f"Audio vorab geladen ({sample_rate} Hz)")
        else:
            audio_input = args.audio
            _emit(
                f"Audio-Preload nicht möglich (Embedding-Rate {sample_rate}, "
                f"Segmentierungs-Rate {segmentation_rate}), lese vom Dateipfad "
                "— alte Speicherspitze"
            )

        hook = ProgressHook()
        diarization = pipeline(audio_input, hook=hook, **diarization_params)

        report_progress(95)

    except Exception as e:
        _emit(f"Fehler: Diarization fehlgeschlagen: {e}")
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

    return annotation


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

    # HF_HOME unter das App-Modellverzeichnis lenken — wie in ner_service.py und
    # aus demselben Grund: huggingface_hub liest den Pfad beim IMPORT in seine
    # Konstanten, die Variable muss also VOR `from pyannote.audio import Pipeline`
    # stehen. Die Modelle selbst kommen zwar über cache_dir=, aber der Hub greift
    # daneben auf ~/.cache/huggingface zu (Token-Datei, Config). Auf einem Mac
    # ohne diesen Ordner ist das folgenlos, unter jeder Sandbox mit Read-Deny
    # aber ein PermissionError, den huggingface_hub — anders als ein fehlendes
    # File — nicht abfängt: der Modell-Load stirbt mit Exit 2.
    os.environ.setdefault("HF_HOME", os.path.join(args.model_dir, "hf"))

    # Validate audio file
    if not os.path.isfile(args.audio):
        _emit(f"Fehler: Audiodatei nicht gefunden: {args.audio}")
        sys.exit(1)

    report_progress(0)

    # Ab hier laufen Import, Modell-Load und Inferenz — Phasen, in denen
    # minutenlang kein [PROGRESS] fällt. Der Heartbeat hält den Watchdog
    # im Main-Prozess ruhig, ohne den Progress-Wert zu verändern.
    with heartbeat():
        annotation = run_diarization(args)

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
