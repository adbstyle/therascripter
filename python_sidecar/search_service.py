#!/usr/bin/env python3
"""
Suchdienst: Text-Encoder von EmbeddingGemma 2 als langlebiger Prozess.

Liefert Vektoren für die Suche nach Bedeutung (Epic #192). Der Prozess ist
zustandslos: er liest keine Datenbank, hält keine Vektoren und kennt keine
Sitzungen — er übersetzt Text in normalisierte float32-Vektoren. Node hält,
quantisiert und vergleicht sie (siehe docs/product/architecture/ml-pipeline.md).

Herkunft des Encoders: nachgebaut nach `modeling_embedding_gemma2.py` aus
Hugging Face transformers (Copyright The HuggingFace Team, Apache License 2.0),
nur der Text-Zweig, in reinem torch. Grund (ADR-010): flair verlangt
transformers<5, die Modellklasse gibt es erst ab transformers 5 — eine
gemeinsame Umgebung ist unmöglich. Abgesichert wird der Nachbau durch
Goldvektoren aus sentence-transformers (tests/fixtures/search-golden/,
Modus `selftest`). Modell: google/embeddinggemma-2, Google, Apache 2.0.

Die Pipeline entspricht exakt dem sentence-transformers-Modell des Originals
(modules.json): Transformer → Mean-Pooling über die Attention-Maske
(include_prompt) → L2-Normalisierung. Eine separate Dense-Schicht gibt es
dort nicht; die Projektion 512 → 768 sitzt im Modell selbst
(`embedding_projection`) und läuft hier im Forward-Pass mit.

Usage:
    search_service.py serve --model-dir <dir> [--query-prompt …] [--document-prompt …]
                            [--max-tokens 1024]
    search_service.py selftest --model-dir <dir> --golden <json> [--bench 40]
                               [--max-footprint-gib 2.5]
    gemeinsam: [--batch-size 4] [--token-budget 2048] [--pad-multiple 128] [--threads 4]

Protokoll (serve): JSON-Lines, eine Zeile pro Nachricht.
    stdout, erste Zeile:
        {"ready": true, "device": "mps", "dtype": "bfloat16", "load_ms": 1834, "dim": 768}
    stdin → stdout:
        {"id": 1, "op": "ping"}
            → {"id": 1, "ok": true, "device": "mps", "dtype": "bfloat16"}
        {"id": 2, "op": "embed_query", "text": "…"}
            → {"id": 2, "dim": 768, "vector": "<base64 float32 LE>"}
        {"id": 3, "op": "embed_documents", "texts": ["…", "…"]}
            → {"id": 3, "dim": 768, "vectors": ["<base64>", "<base64>"]}
        {"id": 4, "op": "shutdown"}
            → {"id": 4, "ok": true}, danach Exit 0
    Fehler pro Anfrage (der Prozess lebt weiter):
        {"id": 2, "error": {"code": "bad_request", "message": "…"}}
        Codes: bad_json, bad_request, unknown_op, too_large, internal
    stdout trägt AUSSCHLIESSLICH Protokollzeilen: fd 1 wird beim Start auf
    stderr umgebogen, damit auch C-Bibliotheken nichts dazwischenschreiben.
    Alles andere geht über _emit auf stderr, darunter die Vertragszeile
    `Gewichte: <dtype> auf <device>` nach dem Laden (Smoke-Check `search load`).

Lebensdauer: stdin-EOF beendet den Prozess innerhalb von 2 s mit Exit 0, auch
mitten in einem Batch. Ein Wächter-Thread beendet ihn, wenn der Elternprozess
verschwindet (getppid() wechselt).

Exit codes:
    0 = regulär beendet (EOF, shutdown, Elternprozess weg)
    1 = ungültige Argumente
    2 = Modell nicht ladbar
    3 = fataler Fehler im Betrieb
    5 = selftest: Abweichung von den Goldvektoren oder Speichergrenze gerissen

Alles Getestete (Protokoll, Bucketing, base64, OOM-Ablauf) ist ohne torch
importierbar — torch, tokenizers und safetensors werden erst in den
Funktionen geladen (src/main/ml/__tests__/search-service.test.ts).
"""

from __future__ import annotations

import argparse
import base64
import ctypes
import json
import logging
import os
import queue
import sys
import threading
import time
from array import array

DEFAULT_QUERY_PROMPT = "task: search result | query: "
DEFAULT_DOCUMENT_PROMPT = "title: none | text: "
DEFAULT_MAX_TOKENS = 1024

# Aufgefüllt wird pro Batch auf ein Vielfaches von 128 Tokens. Ohne festes
# Raster erzeugt jede neue Sequenzlänge neue MPS-Kernel und Allokationen:
# gemessen 3.9 GiB phys_footprint beim Aufbereiten von 148 Abschnitten,
# mit Raster 128 1.81 GiB und schneller (Bauplan Suche, Befund 3).
DEFAULT_PAD_MULTIPLE = 128
DEFAULT_BATCH_SIZE = 4

# Zweite Grenze pro Batch: Anzahl × aufgefüllte Länge. Vier Texte à 1024
# Tokens trieben den phys_footprint auf 3.4 GiB (gemessen, M5 Pro), zwei à
# 1024 auf 1.8 GiB — die Batchgrösse allein schützt nicht vor langen Texten.
# 2048 = 4 × 512 lässt die üblichen Abschnitte (Ø ~380 Tokens) bei Batch 4.
DEFAULT_TOKEN_BUDGET = 2048
DEFAULT_THREADS = 4

EXPECTED_DIM = 768

# Schutz vor Fehlbedienung, kein Fachlimit: Node schickt Batches zu 4.
MAX_TEXTS_PER_REQUEST = 256
MAX_REQUEST_BYTES = 8 * 1024 * 1024

# stdin-EOF → spätestens nach dieser Frist hart beenden, auch mitten in einem
# Forward-Pass (Vertrag: Exit binnen 2 s).
EOF_EXIT_GRACE_SEC = 1.5
PARENT_POLL_SEC = 1.0

# Kosinus-Schwellen gegen die Goldvektoren (fp32 auf der CPU aus dem Original
# mit sentence-transformers). bf16 auf MPS: gemessen ≥ 0.99984 über 148
# Abschnitte; fp32 auf der CPU: identisch bis 2.8e-7.
MIN_COSINE = {"mps": 0.999, "cpu": 0.99999}

# Nur für Messwerkzeuge: "cpu" erzwingt den fp32-Pfad auf der CPU. Die App
# setzt die Variable nie (Whitelist-Env in subprocess.ts).
DEVICE_OVERRIDE_ENV = "THERASCRIPT_SEARCH_DEVICE"

EXIT_BAD_ARGS = 1
EXIT_LOAD = 2
EXIT_FATAL = 3
EXIT_SELFTEST = 5

GIB = 1024**3

_STDERR_LOCK_TIMEOUT_SEC = 2
_stderr_lock = threading.Lock()


def _emit(line: str) -> None:
    """
    Eine Zeile in EINEM write() auf stderr schreiben (wie ner_service.py).

    Bewusst dupliziert statt geteilt: jedes Sidecar-Skript wird einzeln nach
    Contents/Resources/ml_sidecar/ kopiert (electron-builder.yml). Der Lock
    wird mit Timeout genommen — er darf nie blockieren (Begründung in
    ner_service.py, _emit).
    """
    acquired = _stderr_lock.acquire(timeout=_STDERR_LOCK_TIMEOUT_SEC)
    try:
        sys.stderr.write(line + "\n")
        sys.stderr.flush()
    finally:
        if acquired:
            _stderr_lock.release()


class _EmitHandler(logging.Handler):
    """Leitet Logger und Python-Warnungen über _emit."""

    def emit(self, record: "logging.LogRecord") -> None:
        try:
            _emit(self.format(record))
        except Exception:  # noqa: BLE001 — Logging darf den Lauf nie kippen
            self.handleError(record)


# ---------------------------------------------------------------------------
# Protokoll (ohne torch)
# ---------------------------------------------------------------------------


class RequestError(Exception):
    """Fehler einer einzelnen Anfrage — wird beantwortet, der Prozess lebt weiter."""

    def __init__(self, code: str, message: str, request_id=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.request_id = request_id


def error_response(request_id, code: str, message: str) -> dict:
    return {"id": request_id, "error": {"code": code, "message": message}}


def _valid_id(value) -> bool:
    # bool ist eine int-Unterklasse — true als ID wäre ein Aufruferfehler.
    return (isinstance(value, int) and not isinstance(value, bool)) or isinstance(value, str)


def parse_request(line) -> dict:
    """
    Eine Protokollzeile prüfen und normalisieren.

    → {"id", "op", ...} mit den Feldern der Operation. Wirft RequestError mit
    der ID, sofern sie lesbar war (sonst None), damit die Antwort zugeordnet
    werden kann.
    """
    if isinstance(line, (bytes, bytearray)):
        try:
            line = line.decode("utf-8")
        except UnicodeDecodeError as e:
            raise RequestError("bad_json", f"Zeile ist kein UTF-8: {e}") from None
    try:
        message = json.loads(line)
    except ValueError as e:
        raise RequestError("bad_json", f"Zeile ist kein JSON: {e}") from None
    if not isinstance(message, dict):
        raise RequestError("bad_request", "Anfrage muss ein JSON-Objekt sein")

    request_id = message.get("id")
    if not _valid_id(request_id):
        raise RequestError("bad_request", "Feld 'id' fehlt oder ist weder Zahl noch Text")

    op = message.get("op")
    if not isinstance(op, str):
        raise RequestError("bad_request", "Feld 'op' fehlt", request_id)

    if op in ("ping", "shutdown"):
        return {"id": request_id, "op": op}

    if op == "embed_query":
        text = message.get("text")
        if not isinstance(text, str):
            raise RequestError("bad_request", "embed_query braucht 'text' (Text)", request_id)
        return {"id": request_id, "op": op, "text": text}

    if op == "embed_documents":
        texts = message.get("texts")
        if not isinstance(texts, list) or not all(isinstance(t, str) for t in texts):
            raise RequestError(
                "bad_request", "embed_documents braucht 'texts' (Liste von Texten)", request_id
            )
        if len(texts) > MAX_TEXTS_PER_REQUEST:
            raise RequestError(
                "too_large",
                f"höchstens {MAX_TEXTS_PER_REQUEST} Texte pro Anfrage, erhalten {len(texts)}",
                request_id,
            )
        return {"id": request_id, "op": op, "texts": texts}

    raise RequestError("unknown_op", f"unbekannte Operation: {op}", request_id)


def encode_response(message: dict) -> str:
    """Eine Antwort als genau eine Zeile (ASCII-JSON, Zeilenumbruch am Ende)."""
    return json.dumps(message, separators=(",", ":")) + "\n"


TOO_LARGE = object()


def read_lines(stream, max_bytes: int = MAX_REQUEST_BYTES):
    """
    Zeilen aus einem Byte-Stream lesen, ohne eine übergrosse Zeile ganz zu puffern.

    Liefert bytes (ohne Zeilenende) oder TOO_LARGE für eine Zeile über
    max_bytes; deren Rest wird bis zum nächsten Zeilenende verworfen.
    Leere Zeilen werden übersprungen. Endet bei EOF.
    """
    while True:
        line = stream.readline(max_bytes + 1)
        if not line:
            return
        if len(line) > max_bytes and not line.endswith(b"\n"):
            while True:
                rest = stream.readline(max_bytes)
                if not rest or rest.endswith(b"\n"):
                    break
            yield TOO_LARGE
            continue
        line = line.rstrip(b"\r\n")
        if line.strip():
            yield line


def encode_float32(values) -> str:
    """
    float32 little-endian, base64. Nimmt bytes-artige Puffer (numpy-Zeilen
    via .tobytes()) oder eine Folge von Zahlen.
    """
    if isinstance(values, (bytes, bytearray, memoryview)):
        raw = bytes(values)
    else:
        buf = array("f", values)
        if sys.byteorder == "big":
            buf.byteswap()
        raw = buf.tobytes()
    return base64.b64encode(raw).decode("ascii")


def decode_float32(text: str) -> list:
    buf = array("f")
    buf.frombytes(base64.b64decode(text))
    if sys.byteorder == "big":
        buf.byteswap()
    return buf.tolist()


def cosine(a, b) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(y * y for y in b) ** 0.5
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


# ---------------------------------------------------------------------------
# Bucketing (ohne torch)
# ---------------------------------------------------------------------------


def padded_length(length: int, pad_multiple: int, max_tokens: int) -> int:
    """Auf das nächste Vielfache von pad_multiple, nie über max_tokens."""
    if pad_multiple <= 1:
        return min(length, max_tokens)
    rounded = -(-length // pad_multiple) * pad_multiple
    return min(rounded, max_tokens)


def plan_batches(
    lengths, batch_size: int, pad_multiple: int, max_tokens: int, token_budget=None
) -> list:
    """
    Batches nach Länge sortiert bilden, damit kurze Texte nicht auf die Länge
    eines langen aufgefüllt werden.

    Ein Batch hat höchstens batch_size Texte und — sofern token_budget gesetzt
    ist — höchstens token_budget aufgefüllte Token-Slots (Anzahl × Länge);
    ein einzelner Text passt immer.

    → [{"indices": [...], "padded": L}, ...] in Verarbeitungsreihenfolge
    (längste zuerst: ein OOM zeigt sich dann im ersten Batch, nicht nach
    getaner Arbeit). Sortierung stabil, gleich lange Texte behalten ihre
    Reihenfolge. Jeder Index kommt genau einmal vor.
    """
    if batch_size < 1:
        raise ValueError("batch_size muss ≥ 1 sein")
    order = sorted(range(len(lengths)), key=lambda i: -lengths[i])
    batches = []
    start = 0
    while start < len(order):
        # Der erste Text eines Batches ist der längste und bestimmt die Länge.
        padded = padded_length(lengths[order[start]], pad_multiple, max_tokens)
        size = batch_size
        if token_budget is not None:
            size = max(1, min(size, token_budget // max(1, padded)))
        batches.append({"indices": order[start : start + size], "padded": padded})
        start += size
    return batches


def pad_batch(sequences, padded: int, pad_id: int):
    """Rechts auffüllen (wie das Original, padding_side=right) → (ids, maske)."""
    ids, mask = [], []
    for seq in sequences:
        seq = list(seq[:padded])
        fill = padded - len(seq)
        ids.append(seq + [pad_id] * fill)
        mask.append([1] * len(seq) + [0] * fill)
    return ids, mask


def is_oom_error(error: BaseException) -> bool:
    return isinstance(error, RuntimeError) and "out of memory" in str(error).lower()


class EncoderState:
    """Veränderlicher Zustand: Gerät, dtype und Batchgrösse nach OOM-Rückzügen."""

    def __init__(self, device: str, dtype: str, batch_size: int, token_budget=None):
        self.device = device
        self.dtype = dtype
        self.batch_size = batch_size
        self.token_budget = token_budget


def embed_tokens(sequences, state, forward, release, to_cpu, pad_multiple, max_tokens, pad_id):
    """
    Token-Folgen in Batches durch forward() schicken, mit OOM-Rückzug.

    forward(ids, mask) → pro Zeile ein Vektor (indexierbar); release() gibt
    nach jedem Batch den MPS-Cache frei; to_cpu() verlegt das Modell auf die
    CPU in fp32. Bei einem MPS-OOM sinkt die Batchgrösse auf die Hälfte des
    gescheiterten Batches (bleibt für die Lebensdauer des Prozesses — der
    Speicher dieser Maschine ändert sich nicht) und der Rest wird neu geplant;
    erst ein einzelner Text geht auf die CPU.

    Die Reaktion läuft bewusst NACH dem except-Block: solange er aktiv ist,
    hält der Traceback die Aktivierungen des gescheiterten Passes auf der GPU
    fest, und weder empty_cache() noch der Umzug auf die CPU hätten Luft
    (NER-Gotcha in CLAUDE.md).

    → Liste der Vektoren in der Reihenfolge von sequences.
    """
    results = [None] * len(sequences)
    pending = list(range(len(sequences)))
    while pending:
        plan = plan_batches(
            [len(sequences[i]) for i in pending],
            state.batch_size,
            pad_multiple,
            max_tokens,
            state.token_budget,
        )
        for batch in plan:
            indices = [pending[j] for j in batch["indices"]]
            ids, mask = pad_batch([sequences[i] for i in indices], batch["padded"], pad_id)

            oom = False
            try:
                vectors = forward(ids, mask)
            except RuntimeError as e:
                if not (state.device == "mps" and is_oom_error(e)):
                    raise
                oom = True

            release()

            if oom and len(indices) > 1:
                state.batch_size = max(1, len(indices) // 2)
                _emit(
                    f"MPS out of memory — halbiere Batchgrösse auf {state.batch_size} "
                    "und plane die verbleibenden Texte neu"
                )
                break

            if oom:
                _emit("MPS out of memory bei einem einzelnen Text — wechsle auf CPU")
                to_cpu()
                state.device = "cpu"
                state.dtype = "float32"
                vectors = forward(ids, mask)

            for row, index in enumerate(indices):
                results[index] = vectors[row]
        pending = [i for i in pending if results[i] is None]
    return results


# ---------------------------------------------------------------------------
# Speicher: phys_footprint via proc_pid_rusage (nie RSS — zählt MPS nicht mit)
# ---------------------------------------------------------------------------


class _RusageInfoV4(ctypes.Structure):
    _fields_ = [("ri_uuid", ctypes.c_uint8 * 16)] + [
        (name, ctypes.c_uint64)
        for name in (
            "ri_user_time ri_system_time ri_pkg_idle_wkups ri_interrupt_wkups ri_pageins "
            "ri_wired_size ri_resident_size ri_phys_footprint ri_proc_start_abstime "
            "ri_proc_exit_abstime ri_child_user_time ri_child_system_time "
            "ri_child_pkg_idle_wkups ri_child_interrupt_wkups ri_child_pageins "
            "ri_child_elapsed_abstime ri_diskio_bytesread ri_diskio_byteswritten "
            "ri_cpu_time_qos_default ri_cpu_time_qos_maintenance ri_cpu_time_qos_background "
            "ri_cpu_time_qos_utility ri_cpu_time_qos_legacy ri_cpu_time_qos_user_initiated "
            "ri_cpu_time_qos_user_interactive ri_billed_system_time ri_serviced_system_time "
            "ri_logical_writes ri_lifetime_max_phys_footprint ri_instructions ri_cycles "
            "ri_billed_energy ri_serviced_energy ri_interval_max_phys_footprint "
            "ri_runnable_time"
        ).split()
    ]


def footprint():
    """
    → (aktueller phys_footprint, Lifetime-Peak, Peak seit reset_footprint_interval())
    in Bytes; lauter None ausserhalb von macOS.
    """
    try:
        libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
        info = _RusageInfoV4()
        if libc.proc_pid_rusage(os.getpid(), 4, ctypes.byref(info)) != 0:
            return None, None, None
        return (
            info.ri_phys_footprint,
            info.ri_lifetime_max_phys_footprint,
            info.ri_interval_max_phys_footprint,
        )
    except OSError:
        return None, None, None


def reset_footprint_interval() -> None:
    """Intervall-Peak zurücksetzen — trennt den Lade-Peak vom Aufbereitungs-Peak."""
    try:
        ctypes.CDLL("/usr/lib/libSystem.B.dylib").proc_reset_footprint_interval(os.getpid())
    except (OSError, AttributeError):
        pass


# ---------------------------------------------------------------------------
# Encoder (torch erst hier)
# ---------------------------------------------------------------------------

_MODULES = None


def _modules():
    """Die nn.Module-Klassen, erst bei Bedarf definiert (torch-Import)."""
    global _MODULES
    if _MODULES is not None:
        return _MODULES

    import torch
    import torch.nn.functional as F
    from torch import nn

    def gelu_tanh(x):
        return F.gelu(x, approximate="tanh")

    def rotate_half(x):
        half = x.shape[-1] // 2
        return torch.cat((-x[..., half:], x[..., :half]), dim=-1)

    class RMSNorm(nn.Module):
        # Gemma-RMSNorm: in fp32 rechnen, Gewicht als Faktor (nicht 1 + w).
        def __init__(self, dim, eps, with_scale=True):
            super().__init__()
            self.eps = eps
            self.with_scale = with_scale
            if with_scale:
                self.weight = nn.Parameter(torch.ones(dim))

        def forward(self, x):
            xf = x.float()
            y = xf * torch.pow(xf.pow(2).mean(-1, keepdim=True) + self.eps, -0.5)
            if self.with_scale:
                y = y * self.weight.float()
            return y.type_as(x)

    class Attention(nn.Module):
        def __init__(self, c, index):
            super().__init__()
            layer_cfg = c.get("per_layer_config", {}).get(f"{index:02d}", {})
            self.head_dim = layer_cfg.get("head_dim", c["head_dim"])
            kv_heads = layer_cfg.get("num_key_value_heads", c["num_key_value_heads"])
            self.heads = c["num_attention_heads"]
            self.groups = self.heads // kv_heads
            hidden, eps = c["hidden_size"], c["rms_norm_eps"]
            self.q_proj = nn.Linear(hidden, self.heads * self.head_dim, bias=False)
            self.k_proj = nn.Linear(hidden, kv_heads * self.head_dim, bias=False)
            self.v_proj = nn.Linear(hidden, kv_heads * self.head_dim, bias=False)
            self.o_proj = nn.Linear(self.heads * self.head_dim, hidden, bias=False)
            self.q_norm = RMSNorm(self.head_dim, eps)
            self.k_norm = RMSNorm(self.head_dim, eps)
            self.v_norm = RMSNorm(self.head_dim, eps, with_scale=False)

        def forward(self, x, mask, cos, sin):
            batch, length, _ = x.shape
            shape = (batch, length, -1, self.head_dim)
            q = self.q_norm(self.q_proj(x).view(shape).transpose(1, 2))
            k = self.k_norm(self.k_proj(x).view(shape).transpose(1, 2))
            v = self.v_norm(self.v_proj(x).view(shape).transpose(1, 2))
            cos, sin = cos.unsqueeze(1), sin.unsqueeze(1)
            q = q * cos + rotate_half(q) * sin
            k = k * cos + rotate_half(k) * sin
            if self.groups > 1:
                k = k.repeat_interleave(self.groups, dim=1)
                v = v.repeat_interleave(self.groups, dim=1)
            # scale=1.0: die Skalierung steckt in q_norm (wie im Original).
            out = F.scaled_dot_product_attention(q, k, v, attn_mask=mask, scale=1.0)
            return self.o_proj(out.transpose(1, 2).reshape(batch, length, -1))

    class MLP(nn.Module):
        def __init__(self, hidden, intermediate):
            super().__init__()
            self.gate_proj = nn.Linear(hidden, intermediate, bias=False)
            self.up_proj = nn.Linear(hidden, intermediate, bias=False)
            self.down_proj = nn.Linear(intermediate, hidden, bias=False)

        def forward(self, x):
            return self.down_proj(gelu_tanh(self.gate_proj(x)) * self.up_proj(x))

    class PLEBlock(nn.Module):
        def __init__(self, c):
            super().__init__()
            hidden, per_layer = c["hidden_size"], c["hidden_size_per_layer_input"]
            self.per_layer_input_gate = nn.Linear(hidden, per_layer, bias=False)
            self.per_layer_projection = nn.Linear(per_layer, hidden, bias=False)
            self.post_per_layer_input_norm = RMSNorm(hidden, c["rms_norm_eps"])

        def forward(self, x, per_layer_input):
            gated = gelu_tanh(self.per_layer_input_gate(x)) * per_layer_input
            return x + self.post_per_layer_input_norm(self.per_layer_projection(gated))

    class Layer(nn.Module):
        def __init__(self, c, index):
            super().__init__()
            hidden, eps = c["hidden_size"], c["rms_norm_eps"]
            self.self_attn = Attention(c, index)
            self.mlp = MLP(hidden, c["intermediate_size"])
            self.input_layernorm = RMSNorm(hidden, eps)
            self.post_attention_layernorm = RMSNorm(hidden, eps)
            self.pre_feedforward_layernorm = RMSNorm(hidden, eps)
            self.post_feedforward_layernorm = RMSNorm(hidden, eps)
            self.register_buffer("layer_scalar", torch.ones(1))
            self.ple_block = PLEBlock(c)

        def forward(self, x, per_layer_input, mask, cos, sin):
            x = x + self.post_attention_layernorm(
                self.self_attn(self.input_layernorm(x), mask, cos, sin)
            )
            x = x + self.post_feedforward_layernorm(self.mlp(self.pre_feedforward_layernorm(x)))
            return self.ple_block(x, per_layer_input) * self.layer_scalar

    class TextEncoder(nn.Module):
        """
        Text-Zweig von EmbeddingGemma2Model. Die Attribut-Namen entsprechen
        den Tensor-Namen des Originals ohne `language_model.` — so lädt der
        state_dict ohne Umbenennung und strikt.
        """

        def __init__(self, c):
            super().__init__()
            self.c = c
            hidden = c["hidden_size"]
            layers = c["num_hidden_layers"]
            per_layer = c["hidden_size_per_layer_input"]
            self.embed_tokens = nn.Embedding(c["vocab_size"], hidden, c["pad_token_id"])
            self.embed_scale = hidden**0.5
            self.layers = nn.ModuleList([Layer(c, i) for i in range(layers)])
            self.norm = RMSNorm(hidden, c["rms_norm_eps"])
            self.ple = nn.Module()
            self.ple.per_layer_model_projection = nn.Linear(hidden, layers * per_layer, bias=False)
            self.ple.per_layer_projection_norm = RMSNorm(per_layer, c["rms_norm_eps"])
            self.embedding_projection = nn.Linear(hidden, c["embedding_dim"], bias=False)
            # RoPE-Frequenzen pro Layer-Typ, bewusst keine Buffer: sie bleiben
            # fp32 auf der CPU, auch wenn das Modell auf bf16/MPS wechselt.
            full_head_dim = c["head_dim"]
            for layer_cfg in c.get("per_layer_config", {}).values():
                full_head_dim = layer_cfg.get("head_dim", full_head_dim)
            self.inv_freq = {}
            for layer_type, rope in c["rope_parameters"].items():
                head_dim = c["head_dim"] if layer_type == "sliding_attention" else full_head_dim
                steps = torch.arange(0, head_dim, 2, dtype=torch.float32, device="cpu")
                self.inv_freq[layer_type] = 1.0 / (rope["rope_theta"] ** (steps / head_dim))

        def forward(self, ids, attention_mask):
            c = self.c
            dtype = self.embed_tokens.weight.dtype
            x = self.embed_tokens(ids) * torch.tensor(self.embed_scale, dtype=dtype)
            batch, length, _ = x.shape
            layers = c["num_hidden_layers"]
            per_layer = c["hidden_size_per_layer_input"]
            projected = self.ple.per_layer_model_projection(x) * c["hidden_size"] ** -0.5
            per_layer_inputs = self.ple.per_layer_projection_norm(
                projected.reshape(batch, length, layers, per_layer)
            )

            positions = torch.arange(length, device=x.device)
            key_ok = attention_mask.bool()[:, None, None, :]
            # Sliding Window bidirektional: |q − k| ≤ sliding_window
            # (sliding_window_bidirectional_overlay im Original).
            distance = (positions[:, None] - positions[None, :]).abs()
            negative = torch.finfo(dtype).min
            in_window = (distance <= c["sliding_window"])[None, None]
            masks = {
                "full_attention": torch.where(key_ok, 0.0, negative).to(dtype),
                "sliding_attention": torch.where(key_ok & in_window, 0.0, negative).to(dtype),
            }
            rope = {}
            for layer_type, inv_freq in self.inv_freq.items():
                freqs = positions[None, :, None].float() * inv_freq.to(x.device)[None, None, :]
                emb = torch.cat((freqs, freqs), -1)
                rope[layer_type] = (emb.cos().to(dtype), emb.sin().to(dtype))

            for index, layer in enumerate(self.layers):
                layer_type = c["layer_types"][index]
                x = layer(x, per_layer_inputs[:, :, index, :], masks[layer_type], *rope[layer_type])
            return self.embedding_projection(self.norm(x))

    _MODULES = TextEncoder
    return _MODULES


def _release_mps_cache() -> None:
    """MPS-Cache nach jedem Batch zurückgeben (NER-Gotcha: sonst wächst er in den Swap)."""
    import torch

    if not torch.backends.mps.is_available():
        return
    try:
        torch.mps.empty_cache()
    except Exception as cache_error:  # noqa: BLE001 — best effort
        _emit(f"torch.mps.empty_cache() fehlgeschlagen: {cache_error}")


def _pick_device() -> str:
    import torch

    override = os.environ.get(DEVICE_OVERRIDE_ENV)
    if override == "cpu":
        return "cpu"
    return "mps" if torch.backends.mps.is_available() else "cpu"


class Encoder:
    """Geladenes Modell plus Tokenizer, mit Prompts und Bucketing-Parametern."""

    def __init__(self, args):
        import torch
        from safetensors.torch import load_file
        from tokenizers import Tokenizer

        model_dir = args.model_dir
        with open(os.path.join(model_dir, "config.json"), encoding="utf-8") as f:
            config = json.load(f)
        self.config = config.get("text_config", config)
        self.dim = int(self.config["embedding_dim"])
        self.pad_id = int(self.config.get("pad_token_id", 0))
        self.query_prompt = args.query_prompt
        self.document_prompt = args.document_prompt
        self.max_tokens = args.max_tokens
        self.pad_multiple = args.pad_multiple

        self.tokenizer = Tokenizer.from_file(os.path.join(model_dir, "tokenizer.json"))
        # Kürzen auf max_tokens INKLUSIVE <bos>/<eos> (wie sentence-transformers
        # mit max_seq_length); aufgefüllt wird selbst, pro Batch (plan_batches).
        self.tokenizer.enable_truncation(self.max_tokens)
        self.tokenizer.no_padding()

        torch.set_num_threads(max(1, args.threads))
        device = _pick_device()
        weights = os.path.join(model_dir, "model.safetensors")
        TextEncoder = _modules()

        def build(target):
            with torch.device("meta"):
                model = TextEncoder(self.config)
            # bf16 liegt so auf der Platte: auf MPS direkt laden, auf der CPU
            # nach fp32 (bf16 ist dort sehr langsam: 15.9 s für 8 Texte).
            state = load_file(weights, device=target)
            prefix = "language_model."
            state = {k[len(prefix) :]: v for k, v in state.items() if k.startswith(prefix)}
            model.load_state_dict(state, strict=True, assign=True)
            del state
            meta = [n for n, t in list(model.named_parameters()) + list(model.named_buffers()) if t.is_meta]
            if meta:
                raise RuntimeError(f"Gewichte fehlen im Artefakt: {meta[:5]}")
            if target == "mps":
                model = model.to(device="mps", dtype=torch.bfloat16)
            else:
                model = model.float()
            return model.eval()

        try:
            self.model = build(device)
        except RuntimeError as e:
            if device != "mps" or not is_oom_error(e):
                raise
            oom = True
        else:
            oom = False
        if oom:
            # Nach dem except-Block, damit der Traceback den Teil-Load freigibt.
            _emit("MPS out of memory beim Laden — lade auf die CPU")
            _release_mps_cache()
            device = "cpu"
            self.model = build("cpu")

        if device == "mps":
            _release_mps_cache()
        self.state = EncoderState(
            device,
            "bfloat16" if device == "mps" else "float32",
            args.batch_size,
            args.token_budget,
        )
        self.emit_weights()

    def emit_weights(self) -> None:
        # Vertrag mit dem Smoke-Check `search load`: mit MPS muss die Zeile
        # `Gewichte: torch.bfloat16 auf mps` lauten — nie float16 (Gemma
        # überläuft in fp16), nie still fp32 (doppelter Speicher).
        weight = self.model.embed_tokens.weight
        _emit(f"Gewichte: {weight.dtype} auf {weight.device.type}")

    def _forward(self, ids, mask):
        import torch
        import torch.nn.functional as F

        device = self.state.device
        ids_t = torch.tensor(ids, dtype=torch.long, device=device)
        mask_t = torch.tensor(mask, dtype=torch.long, device=device)
        with torch.inference_mode():
            hidden = self.model(ids_t, mask_t)
            # Mean-Pooling über die Maske (inkl. Prompt und <bos>/<eos>, wie
            # 1_Pooling/config.json: include_prompt) — in fp32 summiert.
            weights = mask_t.unsqueeze(-1).to(torch.float32)
            pooled = (hidden.float() * weights).sum(1) / weights.sum(1).clamp(min=1)
            vectors = F.normalize(pooled, dim=-1)
        result = vectors.cpu().numpy().astype("<f4")
        if result.shape[1] != self.dim:
            raise RuntimeError(f"Vektor hat {result.shape[1]} statt {self.dim} Dimensionen")
        return result

    def _to_cpu(self) -> None:
        # Erst verschieben, DANN casten: `to(cpu, float32)` castet auf der GPU
        # und braucht dort neuen Speicher — genau der fehlt nach einem OOM
        # (NER-Gotcha (e)).
        self.model.to("cpu")
        self.model.float()
        _release_mps_cache()
        self.emit_weights()

    def _release(self) -> None:
        if self.state.device == "mps":
            _release_mps_cache()

    def tokenize(self, texts, prompt):
        return [e.ids for e in self.tokenizer.encode_batch([prompt + t for t in texts])]

    def embed(self, texts, prompt):
        """→ Liste von float32-Zeilen (numpy), Reihenfolge wie texts."""
        if not texts:
            return []
        sequences = self.tokenize(texts, prompt)
        return embed_tokens(
            sequences,
            self.state,
            self._forward,
            self._release,
            self._to_cpu,
            self.pad_multiple,
            self.max_tokens,
            self.pad_id,
        )

    def embed_query(self, text):
        return self.embed([text], self.query_prompt)[0]

    def embed_documents(self, texts):
        return self.embed(texts, self.document_prompt)


# ---------------------------------------------------------------------------
# serve
# ---------------------------------------------------------------------------


def _isolate_stdout():
    """
    Protokoll-Kanal sichern: den echten stdout auf einen privaten fd duplizieren
    und fd 1 auf stderr umbiegen. Danach landet jede fremde Ausgabe — print()
    einer Bibliothek, printf aus C — auf stderr, nie zwischen Protokollzeilen.
    """
    sys.stdout.flush()
    protocol_fd = os.dup(1)
    os.dup2(2, 1)
    sys.stdout = os.fdopen(1, "w", buffering=1, encoding="utf-8", closefd=False)
    return os.fdopen(protocol_fd, "w", buffering=1, encoding="utf-8")


def _start_parent_watch() -> None:
    parent = os.getppid()

    def watch():
        while True:
            time.sleep(PARENT_POLL_SEC)
            if os.getppid() != parent:
                _emit("Elternprozess beendet — Suchdienst beendet sich")
                os._exit(0)

    threading.Thread(target=watch, name="parent-watch", daemon=True).start()


def _start_stdin_reader(lines: "queue.Queue") -> None:
    """
    stdin in einem eigenen Thread lesen. Bei EOF: Sentinel in die Queue und
    eine Frist starten — ist der Haupt-Thread dann noch in einem Forward-Pass
    (oder noch beim Laden), beendet os._exit den Prozess trotzdem rechtzeitig.
    """

    def read():
        try:
            for line in read_lines(sys.stdin.buffer):
                lines.put(line)
        except Exception as e:  # noqa: BLE001 — ein kaputter stdin gilt als EOF
            _emit(f"stdin nicht lesbar: {e}")
        lines.put(None)
        timer = threading.Timer(EOF_EXIT_GRACE_SEC, lambda: os._exit(0))
        timer.daemon = True
        timer.start()

    threading.Thread(target=read, name="stdin-reader", daemon=True).start()


def handle_request(encoder, request: dict) -> dict:
    op = request["op"]
    if op == "ping":
        return {
            "id": request["id"],
            "ok": True,
            "device": encoder.state.device,
            "dtype": encoder.state.dtype,
        }
    if op == "shutdown":
        return {"id": request["id"], "ok": True}
    if op == "embed_query":
        vector = encoder.embed_query(request["text"])
        return {"id": request["id"], "dim": encoder.dim, "vector": encode_float32(vector.tobytes())}
    if op == "embed_documents":
        vectors = encoder.embed_documents(request["texts"])
        return {
            "id": request["id"],
            "dim": encoder.dim,
            "vectors": [encode_float32(v.tobytes()) for v in vectors],
        }
    raise RequestError("unknown_op", f"unbekannte Operation: {op}", request["id"])


def _install_logging() -> None:
    handler = _EmitHandler()
    handler.setFormatter(logging.Formatter("%(name)s: %(message)s"))
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(logging.WARNING)
    logging.captureWarnings(True)


def serve(args) -> int:
    protocol = _isolate_stdout()
    _install_logging()
    _start_parent_watch()
    lines: "queue.Queue" = queue.Queue()
    _start_stdin_reader(lines)

    def send(message: dict) -> None:
        protocol.write(encode_response(message))
        protocol.flush()

    started = time.perf_counter()
    try:
        encoder = Encoder(args)
    except Exception as e:  # noqa: BLE001 — jeder Ladefehler ist fatal
        _emit(f"Fehler: Suchmodell konnte nicht geladen werden: {e}")
        return EXIT_LOAD
    load_ms = int((time.perf_counter() - started) * 1000)
    _emit(f"Suchmodell geladen in {load_ms} ms")
    send(
        {
            "ready": True,
            "device": encoder.state.device,
            "dtype": encoder.state.dtype,
            "load_ms": load_ms,
            "dim": encoder.dim,
        }
    )

    while True:
        line = lines.get()
        if line is None:
            return 0
        if line is TOO_LARGE:
            send(error_response(None, "too_large", f"Zeile über {MAX_REQUEST_BYTES} Bytes"))
            continue
        try:
            request = parse_request(line)
        except RequestError as e:
            send(error_response(e.request_id, e.code, e.message))
            continue
        try:
            response = handle_request(encoder, request)
        except RequestError as e:
            response = error_response(request["id"], e.code, e.message)
        except Exception as e:  # noqa: BLE001 — eine Anfrage darf den Dienst nicht kippen
            _emit(f"Fehler bei Anfrage {request['id']!r} ({request['op']}): {e}")
            response = error_response(request["id"], "internal", str(e))
            if encoder.state.device == "mps":
                _release_mps_cache()
        try:
            send(response)
        except (BrokenPipeError, OSError) as e:
            _emit(f"stdout geschlossen — Suchdienst beendet sich: {e}")
            return EXIT_FATAL
        if request["op"] == "shutdown":
            return 0


# ---------------------------------------------------------------------------
# selftest
# ---------------------------------------------------------------------------

# Für die Speichermessung: deutsche Abschnitte unterschiedlicher Länge, frei
# erfunden. Deterministisch, damit Läufe vergleichbar bleiben.
_BENCH_SENTENCES = [
    "Sprecher 1: Wie ist es Ihnen seit dem letzten Termin ergangen?",
    "Sprecher 2: Die Nächte waren unruhig, ich bin oft um drei Uhr aufgewacht.",
    "Sprecher 1: Was ging Ihnen dann durch den Kopf?",
    "Sprecher 2: Vor allem die Arbeit, die Abgabe am Freitag und der Streit im Team.",
    "Sprecher 1: Sie hatten das Schlaftagebuch erwähnt — haben Sie es geführt?",
    "Sprecher 2: Ja, meistens. Am Wochenende habe ich es vergessen.",
    "Sprecher 1: Mir fällt auf, dass Sie über die Familie kaum sprechen.",
    "Sprecher 2: Das ist schwierig, seit dem Umzug sehen wir uns selten.",
]


def bench_texts(count: int) -> list:
    """count Abschnitte zwischen ~120 und ~600 Tokens (Ø ~360, wie das Referenz-Set)."""
    texts = []
    for i in range(count):
        repeats = 2 + (i * 7) % 12
        parts = [_BENCH_SENTENCES[(i + j) % len(_BENCH_SENTENCES)] for j in range(repeats * 2)]
        texts.append(" ".join(parts))
    return texts


def selftest(args) -> int:
    with open(args.golden, encoding="utf-8") as f:
        golden = json.load(f)

    # Prompts und Länge aus der Fixture, wenn nicht ausdrücklich gesetzt —
    # sonst verglichen wir Äpfel mit Birnen.
    if args.query_prompt is None:
        args.query_prompt = golden["queryPrompt"]
    if args.document_prompt is None:
        args.document_prompt = golden["documentPrompt"]
    if args.max_tokens is None:
        args.max_tokens = golden["maxTokens"]

    started = time.perf_counter()
    encoder = Encoder(args)
    load_ms = int((time.perf_counter() - started) * 1000)

    texts = [entry["text"] for entry in golden["texts"]]
    query_vectors = [encoder.embed_query(t) for t in texts]
    document_vectors = encoder.embed_documents(texts)

    per_text = []
    worst = 1.0
    for entry, q, d in zip(golden["texts"], query_vectors, document_vectors):
        q_cos = cosine(q.tolist(), decode_float32(entry["query"]))
        d_cos = cosine(d.tolist(), decode_float32(entry["document"]))
        worst = min(worst, q_cos, d_cos)
        per_text.append({"id": entry["id"], "query": round(q_cos, 7), "document": round(d_cos, 7)})

    threshold = args.min_cosine if args.min_cosine is not None else MIN_COSINE[encoder.state.device]
    report = {
        "device": encoder.state.device,
        "dtype": encoder.state.dtype,
        "load_ms": load_ms,
        "min_cosine": round(worst, 7),
        "threshold": threshold,
        "parity_ok": worst >= threshold,
        "texts": per_text,
    }

    footprint_ok = True
    if args.bench:
        # Gemessen wird der Peak der Aufbereitung allein (Intervall ab hier),
        # nicht der Lade-Peak — die Grenze `search memory` gilt dem Betrieb.
        chunks = bench_texts(args.bench)
        token_counts = [len(s) for s in encoder.tokenize(chunks, encoder.document_prompt)]
        _, load_peak, _ = footprint()
        reset_footprint_interval()
        t0 = time.perf_counter()
        encoder.embed_documents(chunks)
        elapsed = time.perf_counter() - t0
        current, _, interval_peak = footprint()
        report["bench"] = {
            "chunks": len(chunks),
            "tokens_mean": round(sum(token_counts) / len(token_counts)),
            "tokens_max": max(token_counts),
            "seconds": round(elapsed, 2),
            "ms_per_100": round(elapsed / len(chunks) * 100 * 1000),
            "phys_footprint_bytes": current,
            "phys_footprint_peak_bytes": interval_peak,
            "phys_footprint_load_peak_bytes": load_peak,
            "batch_size": encoder.state.batch_size,
            "device_after": encoder.state.device,
        }
        if args.max_footprint_gib is not None and interval_peak is not None:
            footprint_ok = interval_peak <= args.max_footprint_gib * GIB
            report["bench"]["max_footprint_gib"] = args.max_footprint_gib
            report["bench"]["footprint_ok"] = footprint_ok

    print(json.dumps(report, ensure_ascii=False))
    if report["parity_ok"]:
        _emit(f"search parity ok: min. Kosinus {worst:.7f} ≥ {threshold}")
    else:
        _emit(f"search parity FEHLER: min. Kosinus {worst:.7f} < {threshold}")
    if not footprint_ok:
        _emit("search memory FEHLER: phys_footprint über der Grenze")
    return 0 if report["parity_ok"] and footprint_ok else EXIT_SELFTEST


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    shared = argparse.ArgumentParser(add_help=False)
    shared.add_argument("--model-dir", required=True, help="Verzeichnis des Text-Artefakts")
    shared.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    shared.add_argument("--pad-multiple", type=int, default=DEFAULT_PAD_MULTIPLE)
    shared.add_argument(
        "--token-budget",
        type=int,
        default=DEFAULT_TOKEN_BUDGET,
        help="höchstens so viele aufgefüllte Token-Slots pro Batch",
    )
    shared.add_argument("--threads", type=int, default=DEFAULT_THREADS, help="CPU-Threads")

    parser = argparse.ArgumentParser(
        prog="search_service.py",
        description="Suchdienst: Text-Encoder von EmbeddingGemma 2 (JSON-Lines über stdin/stdout)",
    )
    modes = parser.add_subparsers(dest="mode", required=True)

    serve_parser = modes.add_parser("serve", parents=[shared], help="langlebiger Dienst")
    serve_parser.add_argument("--query-prompt", default=DEFAULT_QUERY_PROMPT)
    serve_parser.add_argument("--document-prompt", default=DEFAULT_DOCUMENT_PROMPT)
    serve_parser.add_argument("--max-tokens", type=int, default=DEFAULT_MAX_TOKENS)

    test_parser = modes.add_parser("selftest", parents=[shared], help="Vergleich mit Goldvektoren")
    test_parser.add_argument("--golden", required=True, help="Goldvektoren (JSON)")
    test_parser.add_argument("--query-prompt", default=None, help="Default: aus der Fixture")
    test_parser.add_argument("--document-prompt", default=None, help="Default: aus der Fixture")
    test_parser.add_argument("--max-tokens", type=int, default=None, help="Default: aus der Fixture")
    test_parser.add_argument("--min-cosine", type=float, default=None)
    test_parser.add_argument(
        "--bench", type=int, default=0, help="zusätzlich N Abschnitte aufbereiten und messen"
    )
    test_parser.add_argument("--max-footprint-gib", type=float, default=None)
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    for name in ("batch_size", "pad_multiple", "token_budget", "threads"):
        if getattr(args, name) < 1:
            _emit(f"Fehler: --{name.replace('_', '-')} muss ≥ 1 sein")
            return EXIT_BAD_ARGS
    if args.max_tokens is not None and args.max_tokens < 8:
        _emit("Fehler: --max-tokens muss ≥ 8 sein")
        return EXIT_BAD_ARGS
    if not os.path.isfile(os.path.join(args.model_dir, "model.safetensors")):
        _emit(f"Fehler: kein Suchmodell in {args.model_dir}")
        return EXIT_LOAD
    if args.mode == "serve":
        return serve(args)
    return selftest(args)


if __name__ == "__main__":
    sys.exit(main())
