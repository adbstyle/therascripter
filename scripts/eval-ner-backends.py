#!/usr/bin/env python3
"""Pre-Ship-Eval gate for NER backends.

Runs each available backend against a directory of gold-labeled test transcripts
and reports Precision/Recall/F1 per (backend, entity-type). Intended use: gate
the default-backend switch on quality (e.g. ai4privacy must reach >= 95% PERSON
recall on real Swiss therapy transcripts before it becomes the new default).

Usage:
    python3 scripts/eval-ner-backends.py \
        --fixtures tests/fixtures/ner-eval/ \
        --backends flair ai4privacy gliner \
        --output eval-report.json

Fixture format (tests/fixtures/ner-eval/<name>.json):
    {
      "segments": [{"text": "...", "start": 0, "end": 5, "speaker": "Person A"}],
      "gold_entities": [
        {"text": "Peter", "type": "PERSON", "segmentIndex": 0,
         "charStart": 0, "charEnd": 5}
      ]
    }

`type` in gold_entities uses the canonical 7 PlaceholderType values. The
script invokes each backend through ner_service.py (so production code paths
are exercised), then maps the native types to canonical via the same logic
that `entity-merger.ts` would apply (mirrored in this script — see
CANONICAL_MAPS below).

Exit codes:
    0 = all configured backends meet their thresholds
    1 = invalid arguments or fixture directory missing
    2 = at least one backend failed its threshold

This script is intentionally script-only — it is NOT a vitest test. It is
gated by the availability of real test fixtures, which contain anonymized
patient data and live outside the repo.
"""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Optional

# Mirror of entity-merger.ts mappings — must stay in lock-step.
CANONICAL_MAPS: dict[str, dict[str, Optional[str]]] = {
    "flair": {
        "PER": "PERSON",
        "LOC": "ORT",
        "MISC": "SONSTIGES",
        "ORG": None,
    },
    "ai4privacy": {
        "O": None,
        "GIVENNAME": "PERSON",
        "SURNAME": "PERSON",
        "TITLE": "PERSON",
        "CITY": "ORT",
        "STREET": "ORT",
        "BUILDINGNUM": "ORT",
        "ZIPCODE": "ORT",
        "DATE": "DATUM",
        "TIME": "DATUM",
        "EMAIL": "KONTAKT",
        "TELEPHONENUM": "KONTAKT",
        "CREDITCARDNUMBER": "KONTAKT",
        "AGE": "SONSTIGES",
        "SEX": "SONSTIGES",
        "GENDER": "SONSTIGES",
        "SOCIALNUM": "SONSTIGES",
        "IDCARDNUM": "SONSTIGES",
        "PASSPORTNUM": "SONSTIGES",
        "DRIVERLICENSENUM": "SONSTIGES",
        "TAXNUM": "SONSTIGES",
    },
    "gliner": {
        "Person": "PERSON",
        "Ort": "ORT",
        "Organisation": "ORGANISATION",
        "Krankheit": "MEDIZINISCH",
        "Medikament": "MEDIZINISCH",
    },
}

# HuggingFace identifiers per backend (mirror of MODEL_DEFINITIONS).
HF_IDENTIFIERS = {
    "flair": "flair/ner-german-large",
    "ai4privacy": "ai4privacy/llama-ai4privacy-multilingual-categorical-anonymiser-openpii",
    "gliner": "urchade/gliner_multi-v2.1",
}

# Acceptance thresholds per (backend, type) — F1 minimum. Tightest threshold
# is PERSON recall, because a missed PERSON span is a PII leak.
THRESHOLDS = {
    "ai4privacy": {"PERSON_recall": 0.95},
    "gliner": {"PERSON_recall": 0.90},
    "flair": {"PERSON_recall": 0.92},  # baseline reference
}


def map_native(backend: str, native_type: str) -> Optional[str]:
    """Mirror of TS-side mapNativeType. Unknown labels for ai4privacy go
    to SONSTIGES (matches the schema-drift policy)."""
    mapping = CANONICAL_MAPS[backend]
    if native_type in mapping:
        return mapping[native_type]
    if backend == "ai4privacy":
        return "SONSTIGES"
    return None


def run_backend(
    backend: str,
    transcript_path: Path,
    sidecar_python: Path,
    sidecar_script: Path,
    model_dir: Path,
) -> list[dict]:
    """Invoke ner_service.py for one fixture and return the predicted
    entities (in native types)."""
    cmd = [
        str(sidecar_python),
        str(sidecar_script),
        "--transcript", str(transcript_path),
        "--backend", backend,
        "--hf-model", HF_IDENTIFIERS[backend],
        "--model-dir", str(model_dir),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if result.returncode != 0:
        raise RuntimeError(
            f"Backend {backend} failed (exit {result.returncode}):\n{result.stderr[-1000:]}"
        )
    output = json.loads(result.stdout)
    return output.get("entities", [])


def overlaps(a: dict, b: dict) -> bool:
    """Return True if two entities overlap by segment + char range."""
    if a.get("segmentIndex") != b.get("segmentIndex"):
        return False
    return a["charStart"] < b["charEnd"] and a["charEnd"] > b["charStart"]


def score_predictions(
    backend: str,
    predictions: list[dict],
    gold: list[dict],
) -> dict[str, dict[str, float]]:
    """Compute precision/recall/F1 per canonical entity type.

    A predicted span is a true positive iff there is a gold span with the
    same (canonical type, overlapping char range, same segment).
    """
    # Map predictions to canonical types; drop those that map to None.
    canonical_preds = []
    for pred in predictions:
        canonical = map_native(backend, pred.get("type", ""))
        if canonical is None:
            continue
        canonical_preds.append({**pred, "type": canonical})

    # Per-type counters.
    types = set(p["type"] for p in canonical_preds) | set(g["type"] for g in gold)
    scores: dict[str, dict[str, float]] = {}

    for entity_type in types:
        tp = 0
        fp = 0
        fn = 0
        type_preds = [p for p in canonical_preds if p["type"] == entity_type]
        type_gold = [g for g in gold if g["type"] == entity_type]
        matched_gold = set()

        for pred in type_preds:
            match_idx = next(
                (i for i, g in enumerate(type_gold) if i not in matched_gold and overlaps(pred, g)),
                None,
            )
            if match_idx is not None:
                tp += 1
                matched_gold.add(match_idx)
            else:
                fp += 1
        fn = len(type_gold) - len(matched_gold)

        precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
        recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
        f1 = (2 * precision * recall) / (precision + recall) if (precision + recall) > 0 else 0.0

        scores[entity_type] = {
            "precision": round(precision, 4),
            "recall": round(recall, 4),
            "f1": round(f1, 4),
            "support": len(type_gold),
        }

    return scores


def evaluate_backend(
    backend: str,
    fixtures: list[Path],
    sidecar_python: Path,
    sidecar_script: Path,
    model_dir: Path,
) -> dict:
    """Aggregate scores across fixtures for one backend."""
    total_predictions: list[dict] = []
    total_gold: list[dict] = []
    fixture_count = 0
    failures: list[str] = []

    for fixture in fixtures:
        with open(fixture, "r", encoding="utf-8") as f:
            data = json.load(f)

        try:
            preds = run_backend(backend, fixture, sidecar_python, sidecar_script, model_dir)
        except Exception as e:
            failures.append(f"{fixture.name}: {e}")
            continue

        # Tag with fixture-relative segment offsets so cross-fixture aggregation works.
        for p in preds:
            p["segmentIndex"] = (fixture_count * 1000) + p.get("segmentIndex", 0)
        for g in data.get("gold_entities", []):
            g["segmentIndex"] = (fixture_count * 1000) + g.get("segmentIndex", 0)

        total_predictions.extend(preds)
        total_gold.extend(data.get("gold_entities", []))
        fixture_count += 1

    return {
        "fixture_count": fixture_count,
        "failures": failures,
        "scores": score_predictions(backend, total_predictions, total_gold),
    }


def check_thresholds(backend: str, report: dict) -> list[str]:
    """Return list of threshold violations for one backend's report."""
    violations: list[str] = []
    requirements = THRESHOLDS.get(backend, {})
    for key, minimum in requirements.items():
        if "_" not in key:
            continue
        entity_type, metric = key.rsplit("_", 1)
        scores = report["scores"].get(entity_type)
        if scores is None:
            violations.append(f"{backend}: no {entity_type} entities found in fixtures")
            continue
        actual = scores[metric]
        if actual < minimum:
            violations.append(
                f"{backend}: {entity_type} {metric}={actual:.3f} < {minimum:.3f} (threshold)"
            )
    return violations


def main() -> int:
    parser = argparse.ArgumentParser(description="Pre-Ship-Eval for NER backends")
    parser.add_argument("--fixtures", required=True, type=Path)
    parser.add_argument(
        "--backends",
        nargs="+",
        default=["flair", "ai4privacy", "gliner"],
        choices=["flair", "ai4privacy", "gliner"],
    )
    parser.add_argument("--output", type=Path, default=None)
    parser.add_argument(
        "--sidecar-python",
        type=Path,
        default=Path("python_sidecar/venv/bin/python3"),
    )
    parser.add_argument(
        "--sidecar-script",
        type=Path,
        default=Path("python_sidecar/ner_service.py"),
    )
    parser.add_argument(
        "--model-dir",
        type=Path,
        default=Path(os.path.expanduser("~/.therascript/models/ner")),
    )
    args = parser.parse_args()

    if not args.fixtures.is_dir():
        print(f"Error: fixtures directory not found: {args.fixtures}", file=sys.stderr)
        return 1

    fixtures = sorted(args.fixtures.glob("*.json"))
    if not fixtures:
        print(f"Error: no .json fixtures found in {args.fixtures}", file=sys.stderr)
        return 1

    print(f"Found {len(fixtures)} fixture(s) in {args.fixtures}")

    full_report: dict = {"backends": {}, "violations": []}

    for backend in args.backends:
        print(f"\n=== {backend} ===")
        report = evaluate_backend(
            backend, fixtures, args.sidecar_python, args.sidecar_script, args.model_dir
        )
        full_report["backends"][backend] = report

        if report["failures"]:
            print(f"  FAILURES: {len(report['failures'])} fixture(s) failed")
            for f in report["failures"]:
                print(f"    - {f}")

        for entity_type, metrics in sorted(report["scores"].items()):
            print(
                f"  {entity_type:14s} P={metrics['precision']:.3f}  "
                f"R={metrics['recall']:.3f}  F1={metrics['f1']:.3f}  "
                f"(n={metrics['support']})"
            )

        violations = check_thresholds(backend, report)
        full_report["violations"].extend(violations)

    print()
    if full_report["violations"]:
        print("=== THRESHOLD VIOLATIONS ===")
        for v in full_report["violations"]:
            print(f"  ✗ {v}")
    else:
        print("All backends pass their thresholds.")

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            json.dump(full_report, f, indent=2)
        print(f"\nReport written to {args.output}")

    return 2 if full_report["violations"] else 0


if __name__ == "__main__":
    sys.exit(main())
