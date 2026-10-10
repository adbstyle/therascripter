#!/usr/bin/env python3
"""
Evaluation lokaler Embedding-Modelle für eine semantische Suche über Sitzungstranskripte.

Vergleicht mehrere Sentence-Transformers-Modelle und BM25 als Stichwort-Untergrenze auf
einem deutschen Korpus aus zwei Teilen (tests/fixtures/embedding-eval/):

  - sessions/*.txt  synthetische Therapiesitzungen (eingecheckt), eine Zeile pro
                    Redebeitrag, `T: ` / `K: `.
  - podcast/        echte Sprache: die SRF-Podcasts aus tests/fixtures/podcast-audio/,
                    durch pyannote + whisper-cli transkribiert (gitignored, Urheberrecht).

Relevanz wird auf UNITS bewertet (ein Redebeitrag, lange Beiträge an Satzgrenzen in
Stücke von höchstens MAX_UNIT_WORDS Wörtern geteilt), nicht auf Chunks. Ein Chunk erbt
die höchste Note seiner Units. So bleiben die Bewertungen gültig, wenn die Chunk-Grösse
variiert (--target-words).

Ablauf:
    PY=<eval-venv>/bin/python   # Abhängigkeiten: scripts/eval-embeddings-requirements.txt
    $PY scripts/eval-embeddings.py podcast-turns --rttm-dir <dir> --whisper-dir <dir>
    $PY scripts/eval-embeddings.py units [--doc a1]          # Units zum Bewerten anzeigen
    $PY scripts/eval-embeddings.py run --all                 # jedes Modell im eigenen Prozess
    $PY scripts/eval-embeddings.py pool --k 10               # unbewertete Top-Treffer
    $PY scripts/eval-embeddings.py report

Speicher wird als phys_footprint gemessen (proc_pid_rusage), nie als RSS — RSS zählt
MPS-Allokationen nicht mit (siehe NER-RAM-Gotcha in CLAUDE.md). Jedes Modell läuft in
einem eigenen Prozess, damit der Lifetime-Peak nur dieses Modell enthält.
"""

import argparse
import ctypes
import glob
import json
import math
import os
import random
import re
import statistics
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURES = os.path.join(ROOT, "tests", "fixtures", "embedding-eval")
SESSIONS_DIR = os.path.join(FIXTURES, "sessions")
PODCAST_DIR = os.path.join(FIXTURES, "podcast")
RESULTS_DIR = os.path.join(FIXTURES, "results")
QUERIES_FILE = os.path.join(FIXTURES, "queries.jsonl")
QRELS_FILE = os.path.join(FIXTURES, "qrels.jsonl")

MAX_UNIT_WORDS = 120
DEFAULT_TARGET_WORDS = 200
# Überlappung: der letzte Unit eines Chunks beginnt auch den nächsten, sofern er kurz ist.
MAX_OVERLAP_WORDS = 60
MAX_SEQ_LENGTH = 1024
BATCH_SIZE = 8
# Sparsamer Modus für die Speicher-Bedingung: kleine Batches + empty_cache pro Batch.
LEAN_BATCH_SIZE = 4

# Prompts exakt wie in config_sentence_transformers.json der Modelle (Herstellervorgabe,
# nicht auf dieses Korpus getunt).
MODELS = {
    "harrier-0.6b": {
        "id": "microsoft/harrier-oss-v1-0.6b",
        "dtype": "float16",
        "query_prompt_name": "web_search_query",
        "license": "MIT",
    },
    "harrier-270m": {
        "id": "microsoft/harrier-oss-v1-270m",
        "dtype": "float16",
        "query_prompt_name": "web_search_query",
        "license": "MIT",
    },
    "qwen3-0.6b": {
        "id": "Qwen/Qwen3-Embedding-0.6B",
        "dtype": "float16",
        "query_prompt_name": "query",
        "license": "Apache-2.0",
    },
    "embeddinggemma-300m": {
        # Model Card: "activations do not support float16".
        "id": "google/embeddinggemma-300m",
        "dtype": "float32",
        "query_prompt_name": "query",
        "doc_prompt_name": "document",
        "license": "Gemma ToU",
    },
    "bge-m3": {
        "id": "BAAI/bge-m3",
        "dtype": "float16",
        "license": "MIT",
    },
    "granite-311m-r2": {
        "id": "ibm-granite/granite-embedding-311m-multilingual-r2",
        "dtype": "float16",
        "license": "Apache-2.0",
    },
}
BM25_KEY = "bm25"
ALL_KEYS = list(MODELS) + [BM25_KEY]

# Entscheidungsregel (siehe README.md). Speicher: absoluter Prozess-Peak im sparsamen Modus
# darf den heutigen Pipeline-Peak (flair-NER, fp16 auf MPS: ~3.5 GiB phys_footprint) nicht
# übersteigen — die Modelle laufen strikt nacheinander. Ursprünglich vorab 2 GiB Zuwachs,
# geändert 2026-10-10, weil der Zuwachs pro Modell 0.5–1 GiB Lade-Overhead enthält.
GATE_PEAK_GIB = 3.5
GATE_INDEX_SECONDS = 20.0
PERMISSIVE = {"MIT", "Apache-2.0"}


# ---------------------------------------------------------------------------
# Korpus → Units → Chunks
# ---------------------------------------------------------------------------

SENTENCE_SPLIT = re.compile(r"(?<=[.!?…])\s+")


def split_turn(text):
    """Teilt einen langen Redebeitrag an Satzgrenzen in Stücke ≤ MAX_UNIT_WORDS."""
    words = text.split()
    if len(words) <= MAX_UNIT_WORDS:
        return [text]
    pieces, current, count = [], [], 0
    for sentence in SENTENCE_SPLIT.split(text):
        n = len(sentence.split())
        if current and count + n > MAX_UNIT_WORDS:
            pieces.append(" ".join(current))
            current, count = [], 0
        current.append(sentence)
        count += n
    if current:
        pieces.append(" ".join(current))
    return pieces


def load_session_turns(path):
    turns = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            role, _, text = line.partition(": ")
            if role not in ("T", "K") or not text:
                raise ValueError(f"{path}: unerwartete Zeile: {line[:60]}")
            turns.append((role, text))
    return turns


def load_corpus():
    """→ {doc_id: [(speaker_label, text), ...]} mit Sprecher-Labels wie in der App."""
    docs = {}
    for path in sorted(glob.glob(os.path.join(SESSIONS_DIR, "*.txt"))):
        docs[os.path.splitext(os.path.basename(path))[0]] = load_session_turns(path)
    for path in sorted(glob.glob(os.path.join(PODCAST_DIR, "*.turns.json"))):
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        docs[data["doc"]] = [(t["speaker"], t["text"]) for t in data["turns"]]
    labelled = {}
    for doc, turns in docs.items():
        order = {}
        labelled[doc] = []
        for speaker, text in turns:
            order.setdefault(speaker, len(order) + 1)
            labelled[doc].append((f"Sprecher {order[speaker]}", text))
    return labelled


def build_units(corpus):
    units = []
    for doc, turns in corpus.items():
        for t, (speaker, text) in enumerate(turns):
            for p, piece in enumerate(split_turn(text)):
                units.append(
                    {
                        "id": f"{doc}:{t:03d}.{p}",
                        "doc": doc,
                        "speaker": speaker,
                        "text": piece,
                        "words": len(piece.split()),
                    }
                )
    return units


def build_chunks(units, target_words):
    by_doc = {}
    for u in units:
        by_doc.setdefault(u["doc"], []).append(u)
    chunks = []
    for doc, doc_units in by_doc.items():
        i, n = 0, 0
        carry = None
        while i < len(doc_units):
            members = [carry] if carry else []
            words = carry["words"] if carry else 0
            new = 0
            while i < len(doc_units) and (words < target_words or new == 0):
                members.append(doc_units[i])
                words += doc_units[i]["words"]
                i += 1
                new += 1
            chunks.append(
                {
                    "id": f"{doc}#{n:03d}",
                    "doc": doc,
                    "units": [u["id"] for u in members],
                    "text": "\n".join(f"{u['speaker']}: {u['text']}" for u in members),
                    "words": words,
                }
            )
            n += 1
            last = members[-1]
            carry = last if last["words"] <= MAX_OVERLAP_WORDS and i < len(doc_units) else None
    return chunks


def load_jsonl(path):
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def load_queries():
    return load_jsonl(QUERIES_FILE)


def load_qrels():
    """→ {query_id: {unit_id: grade}} inklusive expliziter 0-Bewertungen."""
    qrels = {}
    for row in load_jsonl(QRELS_FILE):
        qrels.setdefault(row["q"], {})[row["unit"]] = int(row["grade"])
    return qrels


# ---------------------------------------------------------------------------
# Podcast-Transkripte (whisper-cli -ojf + pyannote-RTTM) → Turns
# ---------------------------------------------------------------------------

NON_SPEECH = re.compile(r"^\W*[\[(*♪].*[\])*♪]\W*$")


def parse_rttm(path):
    segments = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            parts = line.split()
            if len(parts) >= 8 and parts[0] == "SPEAKER":
                start, dur = float(parts[3]), float(parts[4])
                segments.append((start, start + dur, parts[7]))
    return segments


def speaker_for(start, end, segments):
    best, best_overlap = None, 0.0
    for s, e, label in segments:
        overlap = min(end, e) - max(start, s)
        if overlap > best_overlap:
            best, best_overlap = label, overlap
    if best is None and segments:
        mid = (start + end) / 2
        best = min(segments, key=lambda seg: min(abs(seg[0] - mid), abs(seg[1] - mid)))[2]
    return best or "SPEAKER_00"


def cmd_podcast_turns(args):
    os.makedirs(PODCAST_DIR, exist_ok=True)
    for rttm in sorted(glob.glob(os.path.join(args.rttm_dir, "*.rttm"))):
        name = os.path.splitext(os.path.basename(rttm))[0]
        whisper_json = os.path.join(args.whisper_dir, f"{name}.wav.json")
        with open(whisper_json, encoding="utf-8") as f:
            transcription = json.load(f)["transcription"]
        segments = parse_rttm(rttm)
        turns = []
        for seg in transcription:
            text = seg["text"].strip()
            if not text or NON_SPEECH.match(text):
                continue
            start = seg["offsets"]["from"] / 1000
            end = seg["offsets"]["to"] / 1000
            speaker = speaker_for(start, end, segments)
            if turns and turns[-1]["speaker"] == speaker:
                turns[-1]["text"] += " " + text
                turns[-1]["end"] = end
            else:
                turns.append({"speaker": speaker, "start": start, "end": end, "text": text})
        duration = max([t["end"] for t in turns] + [s[1] for s in segments])
        doc = "p-" + name.split("_", 1)[-1]
        out = os.path.join(PODCAST_DIR, f"{doc}.turns.json")
        with open(out, "w", encoding="utf-8") as f:
            json.dump(
                {"doc": doc, "source": name, "duration_s": duration, "turns": turns},
                f,
                ensure_ascii=False,
                indent=1,
            )
        words = sum(len(t["text"].split()) for t in turns)
        print(f"{doc}: {len(turns)} Turns, {words} Wörter, {duration / 60:.1f} min → {out}")


def podcast_words_per_minute():
    total_words, total_min = 0, 0.0
    for path in glob.glob(os.path.join(PODCAST_DIR, "*.turns.json")):
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        total_words += sum(len(t["text"].split()) for t in data["turns"])
        total_min += data["duration_s"] / 60
    return total_words / total_min if total_min else None


# ---------------------------------------------------------------------------
# Speicher: phys_footprint via proc_pid_rusage (rusage_info_v4)
# ---------------------------------------------------------------------------


class RusageInfoV4(ctypes.Structure):
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


_LIBC = ctypes.CDLL("/usr/lib/libSystem.B.dylib")


def footprint():
    """→ (aktueller phys_footprint, Lifetime-Peak, Peak seit reset_interval()) in Bytes."""
    info = RusageInfoV4()
    rc = _LIBC.proc_pid_rusage(os.getpid(), 4, ctypes.byref(info))
    if rc != 0:
        raise OSError("proc_pid_rusage fehlgeschlagen")
    return info.ri_phys_footprint, info.ri_lifetime_max_phys_footprint, info.ri_interval_max_phys_footprint


def reset_interval():
    """Setzt den Intervall-Peak zurück — trennt den Lade-Peak vom Indexier-Peak."""
    _LIBC.proc_reset_footprint_interval(os.getpid())


GIB = 1024**3


# ---------------------------------------------------------------------------
# Läufe
# ---------------------------------------------------------------------------

STOPWORDS = set(
    """
    aber alle allem allen aller alles also am an ander andere anderem anderen anderer anderes
    auch auf aus bei beim bin bis bist da dabei damit dann das dass dein deine dem den denn der
    des dessen die dies diese diesem diesen dieser dieses doch dort du durch ein eine einem einen
    einer eines einfach er es etwas euch euer eure für gegen gewesen hab habe haben hat hatte
    hätte halt hier hin hinter ich ihm ihn ihnen ihr ihre im in indem ins irgendwie ist ja jede
    jedem jeden jeder jedes jetzt kann kein keine keinem keinen können könnte machen man manche
    mein meine mich mir mit muss musste nach nicht nichts noch nun nur ob oder ohne schon sehr
    sein seine sich sie sind so solche soll sollte sondern sonst über um und uns unser unter
    viel vom von vor war waren warum was weil weiter welche wenn wer werde werden wie wieder
    will wir wird wo wollen würde zu zum zur zwar zwischen äh ähm mhm eh okay
    """.split()
)


def bm25_tokens(text, stemmer):
    tokens = [t for t in re.findall(r"\w+", text.lower()) if t not in STOPWORDS]
    return stemmer.stemWords(tokens)


def rank_all(scores, chunk_ids, k=50):
    order = sorted(range(len(chunk_ids)), key=lambda j: -scores[j])[:k]
    return [[chunk_ids[j], float(scores[j])] for j in order]


def run_bm25(chunks, queries):
    import snowballstemmer
    from rank_bm25 import BM25Okapi

    stemmer = snowballstemmer.stemmer("german")
    t0 = time.perf_counter()
    bm25 = BM25Okapi([bm25_tokens(c["text"], stemmer) for c in chunks])
    index_s = time.perf_counter() - t0
    ids = [c["id"] for c in chunks]
    rankings = {q["id"]: rank_all(bm25.get_scores(bm25_tokens(q["text"], stemmer)), ids) for q in queries}
    return rankings, {"index_s": index_s}


def weights_size(model_id):
    from huggingface_hub.constants import HF_HUB_CACHE

    # Nicht snapshot_download(local_files_only=True): das verlangt den VOLLEN Snapshot,
    # die ONNX-/OpenVINO-Varianten wurden aber bewusst nicht geladen.
    pattern = os.path.join(HF_HUB_CACHE, "models--" + model_id.replace("/", "--"), "snapshots", "*")
    files = [
        f
        for f in glob.glob(os.path.join(pattern, "**", "*"), recursive=True)
        if os.path.isfile(f) and "openvino" not in os.path.basename(f)
    ]
    # safetensors bevorzugen; .bin zählt nur, wenn das Repo keine safetensors hat
    # (sonst doppelt, z. B. bei granite: model.safetensors + openvino_model.bin).
    weights = [f for f in files if f.endswith(".safetensors")] or [f for f in files if f.endswith(".bin")]
    return sum(os.path.getsize(f) for f in weights)


NAN_EXIT = 3


def run_model(key, chunks, queries, dtype_override=None):
    import numpy as np
    import torch
    from sentence_transformers import SentenceTransformer

    spec = MODELS[key]
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    base_now = footprint()[0]

    def load(dtype):
        t = time.perf_counter()
        m = SentenceTransformer(
            spec["id"], device=device, model_kwargs={"torch_dtype": getattr(torch, dtype)}
        )
        m.max_seq_length = MAX_SEQ_LENGTH
        return m, time.perf_counter() - t

    def encode_docs(m, batch_size, release_cache):
        """release_cache: GPU-Cache nach jedem Batch freigeben, wie ner_service.py
        (_release_mps_cache) — so liefe es in der App, der Peak ist dann der echte
        Arbeitsspeicher statt des Caching-Allocators."""
        texts = [c["text"] for c in chunks]
        reset_interval()
        t = time.perf_counter()
        parts = []
        step = batch_size if release_cache else len(texts)
        for i in range(0, len(texts), step):
            parts.append(
                m.encode(
                    texts[i : i + step],
                    prompt_name=spec.get("doc_prompt_name"),
                    batch_size=batch_size,
                    normalize_embeddings=True,
                    convert_to_numpy=True,
                )
            )
            if device == "mps":
                torch.mps.synchronize()
                if release_cache:
                    torch.mps.empty_cache()
        elapsed = time.perf_counter() - t
        return np.concatenate(parts), elapsed, footprint()[2]

    dtype = dtype_override or spec["dtype"]
    model, load_s = load(dtype)
    _, load_peak, _ = footprint()
    after_load = footprint()[0]
    doc_emb, encode_s, encode_peak = encode_docs(model, BATCH_SIZE, release_cache=False)
    if not np.isfinite(doc_emb).all():
        # fp16-Überlauf: cmd_run wiederholt das Modell in einem FRISCHEN Prozess mit
        # float32 — ein Retry hier würde den Lifetime-Peak um den gescheiterten Lauf
        # verfälschen.
        sys.exit(NAN_EXIT)
    if device == "mps":
        torch.mps.empty_cache()
    _, lean_encode_s, lean_peak = encode_docs(model, LEAN_BATCH_SIZE, release_cache=True)

    q_texts = [q["text"] for q in queries]
    q_prompt = spec.get("query_prompt_name")
    q_emb = model.encode(q_texts, prompt_name=q_prompt, batch_size=BATCH_SIZE, normalize_embeddings=True)
    latencies = []
    for text in q_texts[:40]:
        t = time.perf_counter()
        model.encode([text], prompt_name=q_prompt, normalize_embeddings=True)
        latencies.append((time.perf_counter() - t) * 1000)

    tokenizer = model.tokenizer
    token_counts = [len(tokenizer(c["text"])["input_ids"]) for c in chunks]
    scores = q_emb @ doc_emb.T
    ids = [c["id"] for c in chunks]
    rankings = {q["id"]: rank_all(scores[i], ids) for i, q in enumerate(queries)}
    perf = {
        "device": device,
        "dtype": dtype,
        "fallback": f"{spec['dtype']} lieferte NaN/Inf" if dtype != spec["dtype"] else None,
        "dim": int(doc_emb.shape[1]),
        "load_s": load_s,
        "encode_s": encode_s,
        "words": sum(c["words"] for c in chunks),
        "tokens": sum(token_counts),
        "truncated": sum(1 for n in token_counts if n > MAX_SEQ_LENGTH),
        "query_latency_ms_median": statistics.median(latencies),
        "lean_encode_s": lean_encode_s,
        "baseline_gib": base_now / GIB,
        "load_peak_gib": load_peak / GIB,
        "after_load_gib": after_load / GIB,
        "encode_peak_gib": encode_peak / GIB,
        "lean_peak_gib": lean_peak / GIB,
        "weights_gib": weights_size(spec["id"]) / GIB,
    }
    return rankings, perf


def cmd_run_one(args):
    corpus = load_corpus()
    chunks = build_chunks(build_units(corpus), args.target_words)
    queries = load_queries()
    if args.model == BM25_KEY:
        rankings, perf = run_bm25(chunks, queries)
    else:
        rankings, perf = run_model(args.model, chunks, queries, args.dtype)
    os.makedirs(RESULTS_DIR, exist_ok=True)
    out = os.path.join(RESULTS_DIR, f"run-{args.model}-w{args.target_words}.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(
            {"model": args.model, "target_words": args.target_words, "chunks": len(chunks), "perf": perf, "rankings": rankings},
            f,
            ensure_ascii=False,
        )
    print(f"{args.model}: {len(chunks)} Chunks, {len(queries)} Queries → {out}")


def cmd_run(args):
    keys = ALL_KEYS if args.all else args.models
    env = dict(os.environ, HF_HUB_OFFLINE="1", TOKENIZERS_PARALLELISM="false")
    for key in keys:
        cmd = [sys.executable, os.path.abspath(__file__), "run-one", "--model", key, "--target-words", str(args.target_words)]
        rc = subprocess.call(cmd, env=env)
        if rc == NAN_EXIT:
            print(f"{key}: NaN/Inf in {MODELS[key]['dtype']}, wiederhole in float32", file=sys.stderr)
            rc = subprocess.call(cmd + ["--dtype", "float32"], env=env)
        if rc != 0:
            print(f"{key}: Exit {rc}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Pooling, Metriken, Report
# ---------------------------------------------------------------------------


def load_runs(target_words):
    runs = {}
    for key in ALL_KEYS:
        path = os.path.join(RESULTS_DIR, f"run-{key}-w{target_words}.json")
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                runs[key] = json.load(f)
    return runs


def cmd_units(args):
    for u in build_units(load_corpus()):
        if args.doc and u["doc"] != args.doc:
            continue
        print(f"[{u['id']}] {u['speaker']}: {u['text']}")


def cmd_pool(args):
    corpus = load_corpus()
    units = {u["id"]: u for u in build_units(corpus)}
    chunks = {c["id"]: c for c in build_chunks(list(units.values()), args.target_words)}
    qrels = load_qrels()
    runs = load_runs(args.target_words)
    todo = []
    for q in load_queries():
        judged = qrels.get(q["id"], {})
        pooled = []
        for run in runs.values():
            for chunk_id, _ in run["rankings"].get(q["id"], [])[: args.k]:
                for unit_id in chunks[chunk_id]["units"]:
                    if unit_id not in judged and unit_id not in pooled:
                        pooled.append(unit_id)
        for unit_id in pooled:
            todo.append({"q": q["id"], "query": q["text"], "unit": unit_id, "text": units[unit_id]["text"]})
    out = os.path.join(RESULTS_DIR, f"pool-todo-w{args.target_words}.jsonl")
    with open(out, "w", encoding="utf-8") as f:
        for row in todo:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(f"{len(todo)} unbewertete Query-Unit-Paare → {out}")


def chunk_grades(chunks, rels):
    return {c["id"]: max((rels.get(u, 0) for u in c["units"]), default=0) for c in chunks}


def query_metrics(ranking, grades, rels, chunks_by_id):
    top = [cid for cid, _ in ranking[:10]]
    gains = [grades.get(cid, 0) for cid in top]
    dcg = sum(g / math.log2(i + 2) for i, g in enumerate(gains))
    ideal = sorted(grades.values(), reverse=True)[:10]
    idcg = sum(g / math.log2(i + 2) for i, g in enumerate(ideal))
    best = max(grades.values())
    hit5 = 1.0 if any(grades.get(cid, 0) == best for cid in top[:5]) else 0.0
    mrr = next((1 / (i + 1) for i, g in enumerate(gains) if g > 0), 0.0)
    relevant_units = {u for u, g in rels.items() if g > 0}
    covered = {u for cid in top for u in chunks_by_id[cid]["units"]} & relevant_units
    return {
        "ndcg10": dcg / idcg if idcg else 0.0,
        "hit5": hit5,
        "mrr10": mrr,
        "unit_recall10": len(covered) / len(relevant_units) if relevant_units else 0.0,
    }


def bootstrap_ci(values, n=2000, seed=7):
    rng = random.Random(seed)
    means = sorted(statistics.fmean(rng.choices(values, k=len(values))) for _ in range(n))
    return means[int(0.025 * n)], means[int(0.975 * n)]


def auc(pos, neg):
    if not pos or not neg:
        return None
    wins = sum(1.0 if p > q else 0.5 if p == q else 0.0 for p in pos for q in neg)
    return wins / (len(pos) * len(neg))


RRF_K = 60


def fuse_rrf(a, b):
    """Reciprocal Rank Fusion (Cormack et al. 2009) zweier Läufe; Score = Summe 1/(k + Rang)."""
    rankings = {}
    for qid in a["rankings"]:
        scores = {}
        for run in (a, b):
            for rank, (cid, _) in enumerate(run["rankings"][qid]):
                scores[cid] = scores.get(cid, 0.0) + 1.0 / (RRF_K + rank + 1)
        rankings[qid] = sorted(([cid, sc] for cid, sc in scores.items()), key=lambda x: -x[1])
    return {"model": f"{a['model']}+bm25", "perf": a["perf"], "rankings": rankings, "hybrid": True}


def cmd_report(args):
    corpus = load_corpus()
    units = build_units(corpus)
    chunks = build_chunks(units, args.target_words)
    chunks_by_id = {c["id"]: c for c in chunks}
    queries = load_queries()
    qrels = load_qrels()
    runs = load_runs(args.target_words)
    if args.hybrid and BM25_KEY in runs:
        for key in [k for k in list(runs) if k != BM25_KEY]:
            runs[f"{key}+bm25"] = fuse_rrf(runs[key], runs[BM25_KEY])
    positives = [q for q in queries if q["type"] != "negativ"]
    negatives = [q for q in queries if q["type"] == "negativ"]
    missing = [q["id"] for q in positives if not any(g > 0 for g in qrels.get(q["id"], {}).values())]
    if missing:
        sys.exit(f"Queries ohne relevante Unit: {missing}")

    per_query = {}
    summary = {}
    for key, run in runs.items():
        rows = {}
        for q in positives:
            rels = qrels[q["id"]]
            grades = chunk_grades(chunks, rels)
            ranking = run["rankings"][q["id"]]
            rows[q["id"]] = query_metrics(ranking, grades, rels, chunks_by_id)
        per_query[key] = rows
        top1_pos = [run["rankings"][q["id"]][0][1] for q in positives]
        top1_neg = [run["rankings"][q["id"]][0][1] for q in negatives]
        ndcgs = [rows[q["id"]]["ndcg10"] for q in positives]
        summary[key] = {
            "ndcg10": statistics.fmean(ndcgs),
            "ndcg10_ci": bootstrap_ci(ndcgs),
            "hit5": statistics.fmean(r["hit5"] for r in rows.values()),
            "mrr10": statistics.fmean(r["mrr10"] for r in rows.values()),
            "unit_recall10": statistics.fmean(r["unit_recall10"] for r in rows.values()),
            "neg_auc": auc(top1_pos, top1_neg),
            "by_type": {},
            "by_part": {},
            "perf": run["perf"],
        }
        for field, bucket in (("type", "by_type"), ("part", "by_part")):
            for value in sorted({q[field] for q in positives}):
                vals = [rows[q["id"]]["ndcg10"] for q in positives if q[field] == value]
                summary[key][bucket][value] = (statistics.fmean(vals), len(vals))

    best = max(summary, key=lambda k: summary[k]["ndcg10"])
    for key in summary:
        diffs = [per_query[key][q["id"]]["ndcg10"] - per_query[best][q["id"]]["ndcg10"] for q in positives]
        summary[key]["diff_to_best_ci"] = bootstrap_ci(diffs)

    def clearly_best(key):
        """Lizenz-Ausnahme (Gemma ToU): nur für das beste Modell, wenn das Δ-Intervall
        JEDES anderen reinen Modells unter 0 liegt."""
        others = [k for k in summary if k in MODELS and k != key]
        return key == best and all(summary[k]["diff_to_best_ci"][1] < 0 for k in others)

    wpm = podcast_words_per_minute()
    for key, s in summary.items():
        perf = s["perf"]
        if key not in MODELS:
            s["gates"] = None
            continue
        # Bedingungen am sparsamen Modus gemessen (so liefe es in der App); der
        # Durchsatz-Modus (Batch 8, ohne Cache-Freigabe) steht daneben im Report.
        words = wpm * 45 if wpm else None
        perf["index_45min_s"] = words / (perf["words"] / perf["encode_s"]) if words else None
        perf["lean_index_45min_s"] = words / (perf["words"] / perf["lean_encode_s"]) if words else None
        perf["load_delta_gib"] = perf["load_peak_gib"] - perf["baseline_gib"]
        perf["encode_delta_gib"] = perf["encode_peak_gib"] - perf["baseline_gib"]
        perf["lean_delta_gib"] = perf["lean_peak_gib"] - perf["baseline_gib"]
        s["gates"] = {
            "lizenz": MODELS[key]["license"] in PERMISSIVE or clearly_best(key),
            "speicher": perf["lean_peak_gib"] <= GATE_PEAK_GIB,
            "indexierung": words is not None and perf["lean_index_45min_s"] <= GATE_INDEX_SECONDS,
        }

    out_json = os.path.join(RESULTS_DIR, f"summary-w{args.target_words}.json")
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(
            {"target_words": args.target_words, "chunks": len(chunks), "units": len(units), "queries": len(queries),
             "negatives": len(negatives), "words_per_minute": wpm, "best": best, "models": summary,
             "per_query": per_query},
            f,
            ensure_ascii=False,
            indent=1,
        )

    order = sorted(summary, key=lambda k: -summary[k]["ndcg10"])
    print(f"Chunks {len(chunks)} (Ziel {args.target_words} Wörter), Units {len(units)}, "
          f"Queries {len(positives)} + {len(negatives)} negativ, Sprechtempo {wpm or 0:.0f} Wörter/min\n")
    print(f"{'Modell':22} {'nDCG@10':>8} {'95%-KI':>13} {'Δ-KI zum Besten':>17} {'Hit@5':>6} {'MRR':>6} "
          f"{'UnitRec':>7} {'NegAUC':>6}")
    for key in order:
        s = summary[key]
        lo, hi = s["ndcg10_ci"]
        dlo, dhi = s["diff_to_best_ci"]
        neg = f"{s['neg_auc']:.2f}" if s["neg_auc"] is not None else "–"
        print(f"{key:22} {s['ndcg10']:8.3f} [{lo:.3f},{hi:.3f}] [{dlo:+.3f},{dhi:+.3f}] {s['hit5']:6.2f} "
              f"{s['mrr10']:6.2f} {s['unit_recall10']:7.2f} {neg:>6}")
    print("\nnDCG@10 nach Typ:")
    types = sorted({q["type"] for q in positives})
    print(f"{'Modell':22} " + " ".join(f"{t[:12]:>12}" for t in types))
    for key in order:
        print(f"{key:22} " + " ".join(f"{summary[key]['by_type'][t][0]:12.3f}" for t in types))
    print("\nnDCG@10 nach Korpusteil:")
    parts = sorted({q["part"] for q in positives})
    print(f"{'Modell':22} " + " ".join(f"{t + ' (' + str(summary[order[0]]['by_part'][t][1]) + ')':>14}" for t in parts))
    for key in order:
        print(f"{key:22} " + " ".join(f"{summary[key]['by_part'][t][0]:14.3f}" for t in parts))
    print("\nPraxis:")
    print("Speicher = Zuwachs phys_footprint über den Prozess-Sockel (torch importiert); "
          "Laden / Indexieren Batch 8 / sparsam (Batch 4 + empty_cache); "
          f"Abs = absoluter Prozess-Peak sparsam (Bedingung ≤ {GATE_PEAK_GIB} GiB)")
    print(f"{'Modell':22} {'dtype':>8} {'Dim':>5} {'Gewichte':>9} {'Laden':>7} {'Idx-B8':>7} {'sparsam':>8} "
          f"{'Abs':>6} {'45min B8':>9} {'45min sp':>9} {'Query':>6}  Gates")
    for key in order:
        p = summary[key]["perf"]
        if key not in MODELS:
            continue
        gates = summary[key]["gates"]
        gate_txt = " ".join(f"{n}:{'ok' if v else 'NEIN'}" for n, v in gates.items())
        print(f"{key:22} {p['dtype']:>8} {p['dim']:5d} {p['weights_gib']:8.2f}G {p['load_delta_gib']:6.2f}G "
              f"{p['encode_delta_gib']:6.2f}G {p['lean_delta_gib']:7.2f}G {p['lean_peak_gib']:5.2f}G {p['index_45min_s']:8.1f}s "
              f"{p['lean_index_45min_s']:8.1f}s {p['query_latency_ms_median']:4.0f}ms  {gate_txt}"
              f"{'  ' + p['fallback'] if p['fallback'] else ''}{'  TRUNC ' + str(p['truncated']) if p['truncated'] else ''}")
    print(f"\n→ {out_json}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("podcast-turns", help="RTTM + whisper-JSON → podcast/<doc>.turns.json")
    p.add_argument("--rttm-dir", required=True)
    p.add_argument("--whisper-dir", required=True)
    p.set_defaults(func=cmd_podcast_turns)

    p = sub.add_parser("units", help="Units zum Bewerten ausgeben")
    p.add_argument("--doc")
    p.set_defaults(func=cmd_units)

    for name, func in (("run", cmd_run), ("run-one", cmd_run_one), ("pool", cmd_pool), ("report", cmd_report)):
        p = sub.add_parser(name)
        p.add_argument("--target-words", type=int, default=DEFAULT_TARGET_WORDS)
        p.set_defaults(func=func)
        if name == "run":
            p.add_argument("--all", action="store_true")
            p.add_argument("--models", nargs="*", default=[], choices=ALL_KEYS)
        if name == "run-one":
            p.add_argument("--model", required=True, choices=ALL_KEYS)
            p.add_argument("--dtype", choices=["float16", "float32"])
        if name == "pool":
            p.add_argument("--k", type=int, default=10)
        if name == "report":
            p.add_argument("--hybrid", action="store_true", help="zusätzlich RRF-Fusion jedes Modells mit BM25")

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
