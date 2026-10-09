#!/usr/bin/env python3
"""
Paritätstest NER: vergleicht die Entities zweier Modellverzeichnisse (Issue #131).

Usage:
    python3 scripts/ner-parity.py <referenz-ner-dir> <kandidat-ner-dir> [--runs N]

Beispiel fp32 (installiert) gegen fp16 (entpacktes v3-Artefakt):
    mkdir -p /tmp/ner-v3 && tar -xzf r2-upload/flair-ner-german-large-v3.tar.gz -C /tmp/ner-v3
    python3 scripts/ner-parity.py ~/.therascript/models/ner /tmp/ner-v3

Läuft über ner_service.py selbst — also exakt der Produktionspfad inklusive
Budget-Packing und dokumentweitem FLERT-Kontext — mit den synthetischen Texten
aus tests/fixtures/ner-parity/ in zwei Profilen: jeder Absatz ein Segment
(Audio-Profil, kurze Diarization-Segmente) und jede Datei ein Segment
(PDF-Profil, ein Segment pro Seite). Verglichen werden Spans und Typen exakt;
die Konfidenzen werden nur als maximale Abweichung berichtet.

Exit 0 bei identischen Spans und Typen, 1 bei Abweichungen.
"""

import argparse
import glob
import json
import os
import re
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NER_SCRIPT = os.path.join(ROOT, "python_sidecar", "ner_service.py")
SIDECAR_PY = os.path.join(ROOT, "python_sidecar", "venv", "bin", "python")
FIXTURES = os.path.join(ROOT, "tests", "fixtures", "ner-parity")
LOAD_LINE = re.compile(r"Modell aus .* geladen \((\d+(?:\.\d+)?)s\)")


def build_segments():
    texts = []
    for path in sorted(glob.glob(f"{FIXTURES}/*.txt")):
        with open(path, encoding="utf-8") as f:
            texts.append(f.read())
    if not texts:
        sys.exit(f"Keine Texte in {FIXTURES}")
    paragraphs = [p.strip() for t in texts for p in t.split("\n\n") if p.strip()]
    pages = [t.strip() for t in texts]
    return [{"text": t} for t in paragraphs + pages]


def run(model_dir, transcript):
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    proc = subprocess.run(
        [SIDECAR_PY, NER_SCRIPT, "--transcript", transcript, "--model-dir", model_dir],
        capture_output=True,
        text=True,
        env=env,
    )
    if proc.returncode != 0:
        sys.exit(f"ner_service.py ({model_dir}) exit {proc.returncode}:\n{proc.stderr[-2000:]}")
    load = LOAD_LINE.search(proc.stderr)
    entities = {
        (e["segmentIndex"], e["charStart"], e["charEnd"], e["type"]): e
        for e in json.loads(proc.stdout)["entities"]
    }
    return entities, float(load.group(1)) if load else None


def main():
    parser = argparse.ArgumentParser(description="NER-Paritätstest zweier Modellverzeichnisse")
    parser.add_argument("reference")
    parser.add_argument("candidate")
    parser.add_argument("--runs", type=int, default=1, help="Läufe pro Modell (Ladezeit-Median)")
    args = parser.parse_args()

    segments = build_segments()
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
        json.dump({"segments": segments}, f, ensure_ascii=False)
        transcript = f.name

    try:
        results = {}
        for label, model_dir in (("Referenz", args.reference), ("Kandidat", args.candidate)):
            loads = []
            for _ in range(args.runs):
                entities, load = run(os.path.expanduser(model_dir), transcript)
                loads.append(load)
            results[label] = entities
            known = sorted(t for t in loads if t is not None)
            median = f"{known[len(known) // 2]:.1f}s" if known else "?"
            print(f"{label}: {len(entities)} Entities, Ladezeit Median {median} {loads}")
    finally:
        os.remove(transcript)

    ref, cand = results["Referenz"], results["Kandidat"]
    only_ref = sorted(ref.keys() - cand.keys())
    only_cand = sorted(cand.keys() - ref.keys())
    shared = ref.keys() & cand.keys()
    max_delta = max((abs(ref[k]["confidence"] - cand[k]["confidence"]) for k in shared), default=0)

    print(f"{len(segments)} Segmente, {len(shared)} identische Entities, "
          f"max. Konfidenz-Abweichung {max_delta:.2e}")
    for label, keys, source in (("nur Referenz", only_ref, ref), ("nur Kandidat", only_cand, cand)):
        for key in keys:
            print(f"  {label}: {source[key]['text']!r} {key}")

    sys.exit(1 if only_ref or only_cand else 0)


if __name__ == "__main__":
    main()
