#!/usr/bin/env python3
"""
Spike #208: Speicherbedarf und Antwortzeit der Suche messen, Trefferqualität auf dem
fiktiven Referenz-Set als Zielwert festlegen.

Referenz-Set: tests/fixtures/search-reference/ (README.md dort). Alles fiktiv, eingecheckt.
Suchmodell: google/embeddinggemma-2 (Apache 2.0, Epic #192 statt embeddinggemma-300m aus ADR-008),
nur der Text-Teil, bf16, Prompts der Model Card.

Eigenes Venv, nie python_sidecar/venv:
    uv venv --python 3.12 <dir> && VIRTUAL_ENV=<dir> uv pip install -r scripts/search-spike-requirements.txt
    PY=<dir>/bin/python

Ablauf:
    $PY scripts/search-spike.py pseudonymize        # entities/*.json → pseudo/*.txt
    $PY scripts/search-spike.py units [--doc a1]    # Units zum Bewerten
    $PY scripts/search-spike.py quality             # Trefferqualität + Zielwert (2 Läufe, frische Prozesse)
    $PY scripts/search-spike.py bench-index         # Speicher-Peak beim Aufbereiten (frischer Prozess)
    $PY scripts/search-spike.py bench-corpus        # 2'000-Sitzungen-Bestand (SQLite, ausserhalb des Repos)
    $PY scripts/search-spike.py bench-search        # Antwortzeit + Speicher, erste und weitere Suchen
    $PY scripts/search-spike.py report              # results/summary.json + Markdown

Speicher wird als phys_footprint gemessen (proc_pid_rusage), nie als RSS: RSS zählt
MPS-Allokationen nicht mit (CLAUDE.md, NER-RAM-Gotcha). Jede Messung läuft in einem
eigenen, frischen Prozess, damit kein Peak den Rest einer anderen Messung enthält.
"""

import argparse
import ctypes
import glob
import hashlib
import json
import math
import os
import random
import re
import sqlite3
import statistics
import subprocess
import sys
import time

T_PROCESS_START = time.perf_counter()

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURES = os.path.join(ROOT, "tests", "fixtures", "search-reference")
SESSIONS_DIR = os.path.join(FIXTURES, "sessions")
REPORTS_DIR = os.path.join(FIXTURES, "reports")
ENTITIES_DIR = os.path.join(FIXTURES, "entities")
PSEUDO_DIR = os.path.join(FIXTURES, "pseudo")
RESULTS_DIR = os.path.join(FIXTURES, "results")
QUERIES_FILE = os.path.join(FIXTURES, "queries.jsonl")
QRELS_FILE = os.path.join(FIXTURES, "qrels.jsonl")
BENCH_DIR = os.path.expanduser("~/.cache/therascript-search-spike")
BENCH_DB = os.path.join(BENCH_DIR, "bench-2000.sqlite")

MODEL_ID = "google/embeddinggemma-2"
# Model Card: bf16 oder fp32, nie fp16. bf16 trifft gleich gut wie fp32 (Evaluation 2026-11-14)
# und braucht 1.9 statt 3.1 GiB.
MODEL_DTYPE = "bfloat16"
# Nur der Text-Teil (271M statt 744M Parameter); Bild- und Audio-Teil liefern für Text
# identische Embeddings, kosten aber Speicher.
MODEL_CONFIG_KWARGS = {"vision_config": None, "audio_config": None}
QUERY_PROMPT = "query"
DOC_PROMPT = "document"
MAX_SEQ_LENGTH = 1024
TARGET_WORDS = 200
MAX_UNIT_WORDS = 120
MAX_OVERLAP_WORDS = 60
LEAN_BATCH_SIZE = 4

# Grenzen aus Story #208 / Epic #192
LIMIT_PEAK_GIB = 3.5
LIMIT_SEARCH_S = 2.0

# Bestand für die Messung: 2'000 Einträge, jede zehnte ein PDF-Bericht, Sitzungen so lang
# wie eine 50-Minuten-Sitzung. 151 Wörter/min aus ADR-008 (45 min ≈ 6'800 Wörter).
BENCH_DOCS = 2000
BENCH_PDF_EVERY = 10
WORDS_PER_MINUTE = 151
BENCH_SESSION_WORDS = 50 * WORDS_PER_MINUTE
BENCH_REPORT_WORDS = 1500
BENCH_TOP_K = 50
BENCH_WARM_QUERIES = 30

GIB = 1024**3

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
    if _LIBC.proc_pid_rusage(os.getpid(), 4, ctypes.byref(info)) != 0:
        raise OSError("proc_pid_rusage fehlgeschlagen")
    return info.ri_phys_footprint, info.ri_lifetime_max_phys_footprint, info.ri_interval_max_phys_footprint


def reset_interval():
    _LIBC.proc_reset_footprint_interval(os.getpid())


# ---------------------------------------------------------------------------
# Korpus → Units → Chunks
# ---------------------------------------------------------------------------

SENTENCE_SPLIT = re.compile(r"(?<=[.!?…])\s+")


def split_turn(text):
    """Teilt einen langen Beitrag an Satzgrenzen in Stücke ≤ MAX_UNIT_WORDS."""
    if len(text.split()) <= MAX_UNIT_WORDS:
        return [text]
    pieces, current, count = [], [], 0
    sentences = []
    for sentence in SENTENCE_SPLIT.split(text):
        # Ein Satz ohne Satzzeichen über MAX_UNIT_WORDS (Mundart, Kommaketten) wird an
        # Wortgrenzen geteilt, sonst entstünde eine übergrosse Unit.
        words = sentence.split()
        sentences += [" ".join(words[i : i + MAX_UNIT_WORDS]) for i in range(0, len(words), MAX_UNIT_WORDS)]
    for sentence in sentences:
        n = len(sentence.split())
        if current and count + n > MAX_UNIT_WORDS:
            pieces.append(" ".join(current))
            current, count = [], 0
        current.append(sentence)
        count += n
    if current:
        pieces.append(" ".join(current))
    return pieces


def read_doc(path):
    """→ (header, [(rolle, text)]). Sitzungen: T/K, Berichte: B."""
    header, turns = None, []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            if not line.strip():
                continue
            if line.startswith("#"):
                header = header or line
                continue
            role, _, text = line.partition(": ")
            if role not in ("T", "K", "B") or not text:
                raise ValueError(f"{path}: unerwartete Zeile: {line[:60]}")
            turns.append((role, text))
    return header, turns


def doc_paths(variant="original"):
    base = PSEUDO_DIR if variant == "pseudo" else None
    paths = sorted(glob.glob(os.path.join(SESSIONS_DIR, "*.txt"))) + sorted(
        glob.glob(os.path.join(REPORTS_DIR, "*.txt"))
    )
    if base:
        paths = [os.path.join(base, os.path.basename(p)) for p in paths]
    return paths


def load_corpus(variant="original"):
    """→ {doc_id: {"kind": session|report, "turns": [(label, text)]}}"""
    docs = {}
    for path in doc_paths(variant):
        doc = os.path.splitext(os.path.basename(path))[0]
        _, turns = read_doc(path)
        kind = "report" if all(r == "B" for r, _ in turns) else "session"
        order = {}
        labelled = []
        for role, text in turns:
            if kind == "report":
                labelled.append(("Bericht", text))
            else:
                order.setdefault(role, len(order) + 1)
                labelled.append((f"Sprecher {order[role]}", text))
        docs[doc] = {"kind": kind, "turns": labelled}
    return docs


def build_units(corpus):
    units = []
    for doc, data in corpus.items():
        for t, (speaker, text) in enumerate(data["turns"]):
            for p, piece in enumerate(split_turn(text)):
                units.append(
                    {"id": f"{doc}:{t:03d}.{p}", "doc": doc, "speaker": speaker, "text": piece,
                     "words": len(piece.split())}
                )
    return units


def build_chunks(units, target_words=TARGET_WORDS):
    by_doc = {}
    for u in units:
        by_doc.setdefault(u["doc"], []).append(u)
    chunks = []
    for doc, doc_units in by_doc.items():
        i, n, carry = 0, 0, None
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
                {"id": f"{doc}#{n:03d}", "doc": doc, "units": [u["id"] for u in members],
                 "text": "\n".join(f"{u['speaker']}: {u['text']}" for u in members), "words": words}
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


def load_qrels():
    """→ {query_id: {unit_id: grade}}, nur Noten 1 und 2; nicht gelistete Units gelten als 0
    (pro Dokument erschöpfend bewertet: jede Unit gegen jede Anfrage)."""
    qrels = {}
    for row in load_jsonl(QRELS_FILE):
        if int(row["grade"]) > 0:
            qrels.setdefault(row["q"], {})[row["unit"]] = int(row["grade"])
    return qrels


# ---------------------------------------------------------------------------
# Pseudonymisierte Fassung (entities/*.json → pseudo/*.txt)
# ---------------------------------------------------------------------------

BOUNDARY = r"(?<![\wÄÖÜäöüß])"
BOUNDARY_END = r"(?![\wÄÖÜäöüß])"


def cmd_pseudonymize(_args):
    os.makedirs(PSEUDO_DIR, exist_ok=True)
    for path in doc_paths():
        doc = os.path.splitext(os.path.basename(path))[0]
        ent_path = os.path.join(ENTITIES_DIR, f"{doc}.json")
        if not os.path.exists(ent_path):
            sys.exit(f"{ent_path} fehlt")
        with open(ent_path, encoding="utf-8") as f:
            entities = json.load(f)["entities"]
        with open(path, encoding="utf-8") as f:
            lines = f.read().split("\n")
        header, body = lines[0], "\n".join(lines[1:])
        # Platzhalter pro (Typ, kanonische Form), nummeriert nach erstem Vorkommen im Text.
        first = {}
        for e in entities:
            m = re.search(BOUNDARY + re.escape(e["text"]) + BOUNDARY_END, body)
            if not m:
                sys.exit(f"{doc}: «{e['text']}» kommt nicht als ganzes Wort vor")
            key = (e["type"], e.get("canonical") or e["text"])
            first[key] = min(first.get(key, m.start()), m.start())
        counters, placeholder = {}, {}
        for key in sorted(first, key=lambda k: first[k]):
            counters[key[0]] = counters.get(key[0], 0) + 1
            placeholder[key] = f"[{key[0]} {counters[key[0]]}]"
        # Längste Form zuerst, damit «Sandra Meier» vor «Meier» ersetzt wird.
        for e in sorted(entities, key=lambda e: -len(e["text"])):
            key = (e["type"], e.get("canonical") or e["text"])
            body = re.sub(BOUNDARY + re.escape(e["text"]) + BOUNDARY_END, placeholder[key], body)
        with open(os.path.join(PSEUDO_DIR, f"{doc}.txt"), "w", encoding="utf-8") as f:
            f.write("# pseudonymisiert aus " + header.lstrip("# ").split(" | ")[0] + "\n" + body)
        print(f"{doc}: {len(placeholder)} Platzhalter")


def cmd_merge_qrels(_args):
    """qrels-parts/*.jsonl (Bewerter-Agents) zu qrels.jsonl hinzufügen; doppelte Paare: höhere Note."""
    rows = {(r["q"], r["unit"]): int(r["grade"]) for r in load_jsonl(QRELS_FILE)}
    unit_ids = {u["id"] for u in build_units(load_corpus())}
    query_ids = {q["id"] for q in load_jsonl(QUERIES_FILE)}
    added = 0
    for path in sorted(glob.glob(os.path.join(FIXTURES, "qrels-parts", "*.jsonl"))):
        for r in load_jsonl(path):
            if r["unit"] not in unit_ids or r["q"] not in query_ids:
                sys.exit(f"{path}: unbekannte Unit oder Anfrage {r}")
            key = (r["q"], r["unit"])
            if int(r["grade"]) > rows.get(key, 0):
                added += key not in rows
                rows[key] = int(r["grade"])
    with open(QRELS_FILE, "w", encoding="utf-8") as f:
        for (q, u), g in sorted(rows.items(), key=lambda x: (int(x[0][0][1:]), x[0][1])):
            f.write(json.dumps({"q": q, "unit": u, "grade": g}, ensure_ascii=False) + "\n")
    print(f"{added} neue Bewertungen, total {len(rows)} → {QRELS_FILE}")


def pool_audit_path(model_id=MODEL_ID):
    return os.path.join(RESULTS_DIR, f"pool-audit-{model_id.split('/')[-1]}.jsonl")


def cmd_pool(_args):
    """Pooling-Audit: Units in den Top-3-Abschnitten jeder Anfrage, die noch keine Note haben,
    verblindet (ohne Rang) zur Nachbewertung → results/pool-audit-<modell>.jsonl. Paare, die
    schon in der Nachprüfung eines anderen Modells lagen, sind dort bewertet und fehlen hier.
    Nach der Bewertung: Urteile nach qrels-parts/, dann merge-qrels und quality neu."""
    path = pool_audit_path()
    if os.path.exists(path):
        sys.exit(f"{path} existiert schon — die Nachprüfung dieses Modells ist gemacht")
    audited = {(r["q"], r["unit"]) for other in glob.glob(os.path.join(RESULTS_DIR, "pool-audit-*.jsonl"))
               for r in load_jsonl(other)}
    run = load_result("quality-run1.json")
    units = {u["id"]: u for u in build_units(load_corpus())}
    chunks = {c["id"]: c for c in build_chunks(list(units.values()))}
    qrels = load_qrels()
    queries = {q["id"]: q for q in load_jsonl(QUERIES_FILE)}
    rows = []
    for pq in run["per_query"]:
        rels = qrels.get(pq["id"], {})
        for cid in pq["top3"]:
            if any(rels.get(u, 0) for u in chunks[cid]["units"]):
                continue
            for uid in chunks[cid]["units"]:
                rows.append({"q": pq["id"], "query": queries[pq["id"]]["text"], "unit": uid, "text": units[uid]["text"]})
    seen, out = set(), []
    for r in rows:
        if (r["q"], r["unit"]) not in seen and (r["q"], r["unit"]) not in audited:
            seen.add((r["q"], r["unit"]))
            out.append(r)
    random.Random(208).shuffle(out)
    with open(path, "w", encoding="utf-8") as f:
        f.writelines(json.dumps(r, ensure_ascii=False) + "\n" for r in out)
    print(f"{len(out)} Paare zur Nachbewertung → {path}")


def cmd_review_sample(_args):
    """Jede fünfte Anfrage (nach ID sortiert) mit ihren bewerteten Stellen für die Prüfung
    durch den Product Owner → results/po-review.md."""
    queries = sorted(load_jsonl(QUERIES_FILE), key=lambda q: int(q["id"][1:]))
    sample = queries[::5]
    qrels = load_qrels()
    units = {u["id"]: u for u in build_units(load_corpus())}
    lines = ["# Stichprobe Relevanzurteile (jede fünfte Anfrage)", "",
             "Prüfen: Stimmen die Noten (2 = gesuchte Stelle, 1 = teilweise)? Fehlt eine offensichtlich",
             "passende Stelle? Ergebnis pro Anfrage in results/po-review.jsonl festhalten.", ""]
    for q in sample:
        rels = qrels.get(q["id"], {})
        lines += [f"## {q['id']} ({q['type']}): «{q['text']}»", "", f"{len(rels)} bewertete Stellen", ""]
        for uid, g in sorted(rels.items(), key=lambda x: (-x[1], x[0])):
            text = units[uid]["text"]
            lines.append(f"- **{g}** `{uid}` {text[:220]}{'…' if len(text) > 220 else ''}")
        lines.append("")
    os.makedirs(RESULTS_DIR, exist_ok=True)
    out = os.path.join(RESULTS_DIR, "po-review.md")
    with open(out, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print(f"{len(sample)} von {len(queries)} Anfragen → {out}")


def cmd_units(args):
    units = build_units(load_corpus())
    for u in units:
        if args.doc and u["doc"] != args.doc:
            continue
        print(json.dumps({"unit": u["id"], "speaker": u["speaker"], "text": u["text"]}, ensure_ascii=False))


# ---------------------------------------------------------------------------
# Modell
# ---------------------------------------------------------------------------


def load_model(device=None, threads=None):
    import torch
    from sentence_transformers import SentenceTransformer

    if threads:
        torch.set_num_threads(threads)
    device = device or ("mps" if torch.backends.mps.is_available() else "cpu")
    model = SentenceTransformer(MODEL_ID, device=device, model_kwargs={"torch_dtype": getattr(torch, MODEL_DTYPE)},
                                config_kwargs=MODEL_CONFIG_KWARGS)
    model.max_seq_length = MAX_SEQ_LENGTH
    return model, device


def encode_lean(model, device, texts):
    """So liefe es in der App: Batch 4, GPU-Cache nach jedem Batch freigeben."""
    import numpy as np
    import torch

    parts = []
    for i in range(0, len(texts), LEAN_BATCH_SIZE):
        parts.append(model.encode(texts[i : i + LEAN_BATCH_SIZE], prompt_name=DOC_PROMPT,
                                  batch_size=LEAN_BATCH_SIZE, normalize_embeddings=True, convert_to_numpy=True))
        if device == "mps":
            torch.mps.synchronize()
            torch.mps.empty_cache()
    return np.concatenate(parts) if parts else np.zeros((0, 768), dtype="float32")


# ---------------------------------------------------------------------------
# Trefferqualität
# ---------------------------------------------------------------------------


def query_metrics(ranking, grades, rels, chunks_by_id):
    top = ranking[:10]
    gains = [grades.get(cid, 0) for cid in top]
    dcg = sum(g / math.log2(i + 2) for i, g in enumerate(gains))
    ideal = sorted(grades.values(), reverse=True)[:10]
    idcg = sum(g / math.log2(i + 2) for i, g in enumerate(ideal))
    best = max(grades.values())
    relevant_units = {u for u, g in rels.items() if g > 0}
    covered = {u for cid in top for u in chunks_by_id[cid]["units"]} & relevant_units
    return {
        "ndcg10": dcg / idcg if idcg else 0.0,
        "hit5": 1.0 if any(grades.get(cid, 0) == best for cid in top[:5]) else 0.0,
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


def cmd_quality_one(args):
    import numpy as np

    corpus = load_corpus()
    units = build_units(corpus)
    chunks = build_chunks(units)
    chunks_by_id = {c["id"]: c for c in chunks}
    queries = load_jsonl(QUERIES_FILE)
    qrels = load_qrels()
    unit_ids = {u["id"] for u in units}
    unjudged = [q["id"] for q in queries if q["type"] != "negativ" and q["id"] not in qrels]
    if unjudged:
        sys.exit(f"Anfragen ohne Relevanzurteile: {unjudged} — erst bewerten und merge-qrels")
    unknown = sorted({u for rels in qrels.values() for u in rels} - unit_ids)
    if unknown:
        sys.exit(f"{len(unknown)} bewertete Units fehlen im Korpus, z. B. {unknown[:5]}")

    model, device = load_model()
    doc_emb = encode_lean(model, device, [c["text"] for c in chunks])
    q_emb = model.encode([q["text"] for q in queries], prompt_name=QUERY_PROMPT, batch_size=8, normalize_embeddings=True)
    if not (np.isfinite(doc_emb).all() and np.isfinite(q_emb).all()):
        sys.exit("NaN/Inf in Embeddings")
    scores = q_emb @ doc_emb.T
    ids = [c["id"] for c in chunks]
    per_query, top_pos, top_neg = [], [], []
    for i, q in enumerate(queries):
        order = np.argsort(-scores[i], kind="stable")
        ranking = [ids[j] for j in order[:50]]
        top_score = float(scores[i][order[0]])
        rels = qrels.get(q["id"], {})
        if not rels:
            if q["type"] == "negativ":
                top_neg.append(top_score)
            per_query.append({"id": q["id"], "type": q["type"], "judged": False, "top_score": top_score,
                              "top3": ranking[:3]})
            continue
        grades = {c["id"]: max((rels.get(u, 0) for u in c["units"]), default=0) for c in chunks}
        top_pos.append(top_score)
        per_query.append({"id": q["id"], "type": q["type"], "judged": True, "top_score": top_score, "top3": ranking[:3],
                          **query_metrics(ranking, grades, rels, chunks_by_id)})
    corpus_hash = hashlib.sha256(
        json.dumps([c["text"] for c in chunks] + [q["text"] for q in queries], ensure_ascii=False).encode()
    ).hexdigest()[:16]
    out = {"device": device, "chunks": len(chunks), "units": len(units), "queries": len(queries),
           "corpus_hash": corpus_hash, "per_query": per_query, "neg_auc": auc(top_pos, top_neg)}
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)


def summarize_quality(run):
    judged = [q for q in run["per_query"] if q["judged"]]
    ndcg = [q["ndcg10"] for q in judged]
    lo, hi = bootstrap_ci(ndcg)
    by_type = {}
    for q in judged:
        by_type.setdefault(q["type"], []).append(q["ndcg10"])
    return {
        "ndcg10": statistics.fmean(ndcg), "ci95": [lo, hi], "n": len(ndcg),
        "hit5": statistics.fmean(q["hit5"] for q in judged),
        "neg_auc": run["neg_auc"],
        "by_type": {t: {"ndcg10": statistics.fmean(v), "n": len(v)} for t, v in sorted(by_type.items())},
    }


def cmd_quality(_args):
    """Zwei Läufe in frischen Prozessen: Wert und Wiederholbarkeit (AK 8–10)."""
    os.makedirs(RESULTS_DIR, exist_ok=True)
    summaries = []
    for run in (1, 2):
        out = os.path.join(RESULTS_DIR, f"quality-run{run}.json")
        subprocess.run([sys.executable, __file__, "quality-one", "--out", out], check=True)
        with open(out, encoding="utf-8") as f:
            summaries.append(summarize_quality(json.load(f)))
    a, b = summaries
    same = round(a["ndcg10"], 2) == round(b["ndcg10"], 2) and round(a["ci95"][0], 2) == round(b["ci95"][0], 2)
    result = {**a, "target": math.floor(a["ci95"][0] * 100) / 100, "repeat": {
        "ndcg10_run2": b["ndcg10"], "ci95_run2": b["ci95"], "same_two_decimals": same}}
    with open(os.path.join(RESULTS_DIR, "quality.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)
    print(json.dumps(result, ensure_ascii=False, indent=1))


# ---------------------------------------------------------------------------
# Speicher beim Aufbereiten
# ---------------------------------------------------------------------------


def session_of_length(words, seed):
    """Fiktive 50-Minuten-Sitzung: Beiträge der Referenz-Sitzungen in zufälliger Folge."""
    rng = random.Random(seed)
    turns = [t for doc, d in load_corpus().items() if d["kind"] == "session" for t in d["turns"]]
    out, n = [], 0
    while n < words:
        t = rng.choice(turns)
        out.append(t)
        n += len(t[1].split())
    return out


def cmd_bench_index_one(args):
    import numpy as np

    base = footprint()[0]
    t = time.perf_counter()
    model, device = load_model(args.device, args.threads)
    load_s = time.perf_counter() - t
    load_peak = footprint()[1]
    turns = session_of_length(BENCH_SESSION_WORDS, seed=1)
    units = build_units({"x": {"turns": turns}})
    chunks = build_chunks(units)
    reset_interval()
    t = time.perf_counter()
    emb = encode_lean(model, device, [c["text"] for c in chunks])
    index_s = time.perf_counter() - t
    if not np.isfinite(emb).all():
        sys.exit("NaN/Inf")
    out = {"device": device, "threads": args.threads, "words": sum(u["words"] for u in units), "chunks": len(chunks),
           "baseline_gib": base / GIB, "load_s": load_s, "load_peak_gib": load_peak / GIB,
           "index_s": index_s, "index_peak_gib": footprint()[2] / GIB, "process_peak_gib": footprint()[1] / GIB}
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1)


def cmd_bench_index(_args):
    os.makedirs(RESULTS_DIR, exist_ok=True)
    for name, extra in (("mps", []), ("cpu4", ["--device", "cpu", "--threads", "4"])):
        out = os.path.join(RESULTS_DIR, f"bench-index-{name}.json")
        subprocess.run([sys.executable, __file__, "bench-index-one", "--out", out, *extra], check=True)
        with open(out, encoding="utf-8") as f:
            print(name, f.read())


# ---------------------------------------------------------------------------
# Bestand von 2'000 Sitzungen
# ---------------------------------------------------------------------------

UMLAUT = str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss", "à": "a", "é": "e", "è": "e"})


def normalize(text):
    return text.lower().translate(UMLAUT)


def cmd_bench_corpus(_args):
    """Vervielfältigte fiktive Sitzungen: jede Bestands-Sitzung ist eine Folge von Abschnitten
    der Referenz-Sitzungen (zufällig, Seed fest), bis 50 Minuten erreicht sind; jede zehnte
    ist ein PDF-Bericht aus Abschnitten der Referenz-Berichte. Abschnitte mit gleichem Text
    teilen ihren Vektor — Suchzeit und Speicher hängen an der Anzahl, nicht am Inhalt."""
    import numpy as np

    os.makedirs(BENCH_DIR, exist_ok=True)
    corpus = load_corpus()
    chunks = build_chunks(build_units(corpus))
    session_chunks = [c for c in chunks if corpus[c["doc"]]["kind"] == "session"]
    report_chunks = [c for c in chunks if corpus[c["doc"]]["kind"] == "report"]
    model, device = load_model()
    pool = session_chunks + report_chunks
    emb = encode_lean(model, device, [c["text"] for c in pool])
    vec = {c["id"]: emb[i] for i, c in enumerate(pool)}

    if os.path.exists(BENCH_DB):
        os.remove(BENCH_DB)
    db = sqlite3.connect(BENCH_DB)
    db.executescript(
        """
        CREATE TABLE docs (id INTEGER PRIMARY KEY, kind TEXT, title TEXT);
        CREATE TABLE chunks (id INTEGER PRIMARY KEY, doc INTEGER, text TEXT, vec BLOB);
        CREATE VIRTUAL TABLE chunk_text USING fts5(norm, tokenize='trigram', detail='none');
        """
    )
    rng = random.Random(2000)
    n_chunks, words = 0, 0
    for d in range(BENCH_DOCS):
        is_report = d % BENCH_PDF_EVERY == BENCH_PDF_EVERY - 1
        source, target = (report_chunks, BENCH_REPORT_WORDS) if is_report else (session_chunks, BENCH_SESSION_WORDS)
        db.execute("INSERT INTO docs VALUES (?,?,?)", (d, "report" if is_report else "session", f"Eintrag {d}"))
        got = 0
        while got < target:
            c = rng.choice(source)
            db.execute("INSERT INTO chunks VALUES (?,?,?,?)", (n_chunks, d, c["text"], vec[c["id"]].astype("float32").tobytes()))
            db.execute("INSERT INTO chunk_text(rowid, norm) VALUES (?,?)", (n_chunks, normalize(c["text"])))
            n_chunks += 1
            got += c["words"]
        words += got
    db.commit()
    db.execute("VACUUM")
    db.close()
    print(f"{BENCH_DOCS} Einträge, {n_chunks} Abschnitte, {words} Wörter, {os.path.getsize(BENCH_DB) / 1e6:.0f} MB → {BENCH_DB}")


def search_once(model, conn, vecs, chunk_doc, text, exact_term):
    """Eine Suche bis zur fertigen, pro Eintrag gruppierten Trefferliste: Anfrage einbetten,
    Ähnlichkeit über alle Abschnitte, exakte Begriffssuche, Gruppieren, Ausschnitte laden."""
    import numpy as np

    q = model.encode([text], prompt_name=QUERY_PROMPT, normalize_embeddings=True)[0]
    scores = vecs @ q
    top = np.argpartition(-scores, BENCH_TOP_K)[:BENCH_TOP_K]
    top = top[np.argsort(-scores[top])]
    exact = [r[0] for r in conn.execute(
        # Trigram-Index: LIKE '%…%' findet Teilwörter («Angst» in «Prüfungsangst»), detail=none
        # hält den Index klein (keine Phrasen-Abfragen nötig).
        "SELECT rowid FROM chunk_text WHERE norm LIKE ? LIMIT 2000", ("%" + normalize(exact_term) + "%",))]
    hits = {}
    for cid in list(top) + exact:
        hits.setdefault(int(chunk_doc[cid]), []).append(int(cid))
    ids = [c for v in hits.values() for c in v][:200]
    placeholders = ",".join("?" * len(ids))
    snippets = conn.execute(f"SELECT id, substr(text, 1, 240) FROM chunks WHERE id IN ({placeholders})", ids).fetchall()
    return len(hits), len(snippets), len(exact)


def cmd_bench_search_one(args):
    """Frischer Prozess = erste Suche nach dem Start der App: Python, Modell und Index laden,
    dann eine Suche. Danach BENCH_WARM_QUERIES weitere Suchen."""
    import numpy as np

    t_imports = time.perf_counter()
    model, device = load_model(args.device, args.threads)
    t_model = time.perf_counter()
    conn = sqlite3.connect(BENCH_DB)
    rows = conn.execute("SELECT id, doc, vec FROM chunks ORDER BY id").fetchall()
    vecs = np.frombuffer(b"".join(r[2] for r in rows), dtype="float32").reshape(len(rows), -1)
    chunk_doc = np.array([r[1] for r in rows])
    del rows
    t_index = time.perf_counter()
    queries = [q for q in load_jsonl(QUERIES_FILE) if q["type"] != "negativ"]
    first = search_once(model, conn, vecs, chunk_doc, queries[0]["text"], "Panik")
    t_first = time.perf_counter()
    terms = ["Velo", "Schlaf", "Mutter", "Arbeit", "Angst", "Spital", "Essen", "Schule"]
    warm = []
    for i, q in enumerate(queries[1 : BENCH_WARM_QUERIES + 1]):
        t = time.perf_counter()
        search_once(model, conn, vecs, chunk_doc, q["text"], terms[i % len(terms)])
        warm.append(time.perf_counter() - t)
    warm.sort()
    out = {
        "device": device, "threads": args.threads, "chunks": int(vecs.shape[0]),
        "index_mib": vecs.nbytes / 2**20,
        "first_search": {"from_spawn_s": time.time() - float(os.environ["SPIKE_SPAWN_TS"]) - (time.perf_counter() - t_first)
                         if os.environ.get("SPIKE_SPAWN_TS") else None,
                         "from_process_start_s": t_first - T_PROCESS_START, "python_imports_s": t_imports - T_PROCESS_START,
                         "model_load_s": t_model - t_imports, "index_load_s": t_index - t_model,
                         "search_s": t_first - t_index, "groups": first[0]},
        "warm_search": {"n": len(warm), "median_s": statistics.median(warm), "p95_s": warm[int(0.95 * len(warm)) - 1],
                        "max_s": warm[-1]},
        "process_peak_gib": footprint()[1] / GIB, "after_search_gib": footprint()[0] / GIB,
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1)


def cmd_bench_search(_args):
    if not os.path.exists(BENCH_DB):
        sys.exit("Zuerst bench-corpus ausführen")
    os.makedirs(RESULTS_DIR, exist_ok=True)
    for name, extra in (("mps", []), ("cpu4", ["--device", "cpu", "--threads", "4"])):
        out = os.path.join(RESULTS_DIR, f"bench-search-{name}.json")
        # Zeitpunkt des Starts mitgeben: die erste Suche zählt ab dem Start des Prozesses,
        # inklusive Python-Interpreter.
        env = {**os.environ, "SPIKE_SPAWN_TS": repr(time.time())}
        subprocess.run([sys.executable, __file__, "bench-search-one", "--out", out, *extra], check=True, env=env)
        with open(out, encoding="utf-8") as f:
            print(name, f.read())


# ---------------------------------------------------------------------------
# Bericht
# ---------------------------------------------------------------------------


def load_result(name):
    path = os.path.join(RESULTS_DIR, name)
    if not os.path.exists(path):
        sys.exit(f"{path} fehlt")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def cmd_report(_args):
    q = load_result("quality.json")
    idx = {k: load_result(f"bench-index-{k}.json") for k in ("mps", "cpu4")}
    srch = {k: load_result(f"bench-search-{k}.json") for k in ("mps", "cpu4")}
    peak = max(max(i["process_peak_gib"] for i in idx.values()), max(s["process_peak_gib"] for s in srch.values()))
    # AK 4: jede Suche nach der ersten, also das Maximum, nicht ein Perzentil.
    warm_worst = max(s["warm_search"]["max_s"] for s in srch.values())
    summary = {
        "quality": q,
        "index": idx,
        "search": srch,
        "derived_8gb": {
            "process_peak_gib": peak,
            "peak_within_limit": peak <= LIMIT_PEAK_GIB,
            "warm_search_max_worst_s": warm_worst,
            "warm_within_limit": warm_worst < LIMIT_SEARCH_S,
            "first_search_worst_s": max(s["first_search"]["from_spawn_s"] for s in srch.values()),
        },
    }
    with open(os.path.join(RESULTS_DIR, "summary.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=1)
    print(json.dumps(summary["derived_8gb"], indent=1))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("pseudonymize")
    p = sub.add_parser("units")
    p.add_argument("--doc")
    sub.add_parser("quality")
    p = sub.add_parser("quality-one")
    p.add_argument("--out", required=True)
    sub.add_parser("bench-index")
    sub.add_parser("bench-corpus")
    sub.add_parser("bench-search")
    for name in ("bench-index-one", "bench-search-one"):
        p = sub.add_parser(name)
        p.add_argument("--out", required=True)
        p.add_argument("--device")
        p.add_argument("--threads", type=int)
    sub.add_parser("report")
    sub.add_parser("merge-qrels")
    sub.add_parser("review-sample")
    sub.add_parser("pool")
    args = parser.parse_args()
    {
        "pseudonymize": cmd_pseudonymize, "units": cmd_units, "quality": cmd_quality,
        "quality-one": cmd_quality_one, "bench-index": cmd_bench_index, "bench-index-one": cmd_bench_index_one,
        "bench-corpus": cmd_bench_corpus, "bench-search": cmd_bench_search,
        "bench-search-one": cmd_bench_search_one, "report": cmd_report,
        "merge-qrels": cmd_merge_qrels, "pool": cmd_pool, "review-sample": cmd_review_sample,
    }[args.cmd](args)


if __name__ == "__main__":
    main()
