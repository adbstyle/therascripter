#!/usr/bin/env python3
"""Paritäts-Fixture für den TS-Chunker der Suche (src/main/search/chunker.ts).

Erzeugt mit den Original-Funktionen aus `scripts/search-spike.py` (Spike #208:
`read_doc`/`load_corpus`, `split_turn`, `build_units`, `build_chunks`) die Units
und Abschnittsgrenzen von Dokumenten im Format des Referenz-Sets
(`sessions/*.txt`, `reports/*.txt`, Zeilen `T:`/`K:`/`B:`).

Braucht nur System-python3 (keine torch-Abhängigkeit: search-spike.py lädt das
Modell erst in den Messbefehlen).

Neu erzeugen (aus dem Repo-Wurzelverzeichnis):

    python3 -I scripts/search-chunker-fixture.py \\
      --spike <pfad>/scripts/search-spike.py \\
      --own src/main/search/__tests__/fixtures/chunker-docs \\
      --reference tests/fixtures/search-reference \\
      > src/main/search/__tests__/fixtures/chunker-parity.json

`--own` nimmt die eigenen fiktiven Dokumente samt Text in die Fixture auf.
`--reference` (optional) nimmt die 14 Dokumente des Referenz-Sets nur mit
Wortzahl und SHA-1 des Unit-Texts auf; deren Texte kommen mit PR #214 ins Repo,
der Test prüft sie erst, wenn sie dort liegen.
"""

import argparse
import hashlib
import importlib.util
import json
import os
import sys


def load_spike(path):
    spec = importlib.util.spec_from_file_location("search_spike", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def corpus_of(spike, root):
    spike.SESSIONS_DIR = os.path.join(root, "sessions")
    spike.REPORTS_DIR = os.path.join(root, "reports")
    return spike.load_corpus()


def describe(spike, root, with_text):
    corpus = corpus_of(spike, root)
    units = spike.build_units(corpus)
    chunks = spike.build_chunks(units)
    docs = {}
    for doc, data in corpus.items():
        doc_units = []
        for u in units:
            if u["doc"] != doc:
                continue
            entry = {"id": u["id"], "speaker": u["speaker"], "words": u["words"]}
            if with_text:
                entry["text"] = u["text"]
            else:
                entry["sha1"] = hashlib.sha1(u["text"].encode("utf-8")).hexdigest()[:12]
            doc_units.append(entry)
        doc_chunks = [
            {"id": c["id"], "units": c["units"], "words": c["words"]} for c in chunks if c["doc"] == doc
        ]
        docs[doc] = {"kind": data["kind"], "units": doc_units, "chunks": doc_chunks}
    return docs


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--spike", required=True, help="Pfad zu scripts/search-spike.py")
    parser.add_argument("--own", required=True, help="Ordner mit eigenen fiktiven Dokumenten")
    parser.add_argument("--reference", help="Ordner des Referenz-Sets (optional)")
    args = parser.parse_args()

    spike = load_spike(args.spike)
    out = {
        "generator": "scripts/search-chunker-fixture.py",
        "constants": {
            "TARGET_WORDS": spike.TARGET_WORDS,
            "MAX_UNIT_WORDS": spike.MAX_UNIT_WORDS,
            "MAX_OVERLAP_WORDS": spike.MAX_OVERLAP_WORDS,
        },
        "own": describe(spike, args.own, with_text=True),
    }
    if args.reference:
        out["reference"] = describe(spike, args.reference, with_text=False)
    json.dump(out, sys.stdout, ensure_ascii=False, separators=(",", ":"))
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
