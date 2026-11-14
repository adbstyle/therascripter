#!/usr/bin/env python3
"""
Goldvektoren für den Suchdienst erzeugen (tests/fixtures/search-golden/golden.json).

Referenz ist das ORIGINAL-Modell google/embeddinggemma-2 mit sentence-transformers
in fp32 auf der CPU — genau die Pipeline, die python_sidecar/search_service.py in
reinem torch nachbaut (ADR-010). Der Suchdienst vergleicht sich im Modus `selftest`
damit; die Smoke-Prüfung `search parity` (scripts/smoke-packaged.sh) und der
Vitest `search-service.test.ts` verlangen Kosinus ≥ 0.999 (bf16 auf MPS) bzw.
≥ 0.99999 (fp32 auf der CPU).

Ausführen (eigenes venv, NICHT das Standalone der App — sentence-transformers
braucht transformers ≥ 5, flair verträgt das nicht):

    python3 -m venv /tmp/eg2-venv
    /tmp/eg2-venv/bin/pip install 'sentence-transformers>=6.1' torch
    HF_HOME=<hf-cache mit google/embeddinggemma-2> HF_HUB_OFFLINE=1 \
        /tmp/eg2-venv/bin/python scripts/make-search-golden.py \
        tests/fixtures/search-golden/golden.json

Ohne HF_HUB_OFFLINE lädt sentence-transformers das Modell beim ersten Lauf
(~1.5 GB, Apache 2.0, laut Model Card nicht gated).

Alle Texte sind frei erfunden; Namen und Orte gehören zu keiner echten Person.
Die Auswahl deckt ab: kurze Anfrage, Mundart, Umlaute und Satzzeichen, Bericht,
Dialog, > 512 Tokens (Sliding Window |q − k| ≤ 512 der lokalen Layer) und
> 1024 Tokens (Kürzung auf max_tokens inklusive <bos>/<eos>).
"""

import base64
import json
import os
import sys

MODEL_ID = "google/embeddinggemma-2"
QUERY_PROMPT = "task: search result | query: "
DOCUMENT_PROMPT = "title: none | text: "
MAX_TOKENS = 1024

# Erfundener Therapieverlauf — verschiedene Sätze, damit lange Texte nicht aus
# Wiederholungen bestehen (Wiederholungen glätten Attention und verstecken Fehler).
STORY = [
    "Sprecher 1: Wie ist es Ihnen seit unserem letzten Gespräch ergangen?",
    "Sprecher 2: Ehrlich gesagt durchzogen, die erste Wochenhälfte war gut, dann kam der Einbruch.",
    "Sprecher 1: Können Sie beschreiben, wann genau der Einbruch begonnen hat?",
    "Sprecher 2: Am Mittwochabend, nach dem Telefonat mit meiner Schwester wegen der Wohnung.",
    "Sprecher 1: Was hat Sie an diesem Telefonat am meisten belastet?",
    "Sprecher 2: Dass sie wieder alles entschieden hat, ohne mich zu fragen, wie früher schon.",
    "Sprecher 1: Das klingt nach einem Muster, das Sie gut kennen.",
    "Sprecher 2: Ja, seit der Kindheit bin ich diejenige, die nachgibt, damit Ruhe herrscht.",
    "Sprecher 1: Und wie haben Sie in dieser Nacht geschlafen?",
    "Sprecher 2: Kaum, ich lag bis vier Uhr wach und habe Gespräche im Kopf durchgespielt.",
    "Sprecher 1: Haben Sie die Atemübung ausprobiert, die wir besprochen hatten?",
    "Sprecher 2: Zweimal, beim zweiten Mal hat es geholfen, beim ersten war ich zu aufgewühlt.",
    "Sprecher 1: Das ist ein wichtiger Unterschied, den wir uns merken sollten.",
    "Sprecher 2: Am Donnerstag bin ich trotzdem zur Arbeit, obwohl ich mich krank gefühlt habe.",
    "Sprecher 1: Was hat Sie bewogen, trotzdem hinzugehen?",
    "Sprecher 2: Die Angst, dass mein Chef denkt, ich sei unzuverlässig, so kurz vor der Beurteilung.",
    "Sprecher 1: Gab es im Büro Momente, in denen es Ihnen besser ging?",
    "Sprecher 2: In der Mittagspause mit Frau Keller vom Empfang, wir sind an den See spaziert.",
    "Sprecher 1: Bewegung draussen scheint Ihnen gutzutun, das fällt mir nicht zum ersten Mal auf.",
    "Sprecher 2: Stimmt, nach dem Spaziergang war der Druck auf der Brust fast weg.",
    "Sprecher 1: Wie war das Wochenende, waren Sie wie geplant in den Bergen?",
    "Sprecher 2: Nein, es hat geregnet, und ich habe den ganzen Samstag auf dem Sofa verbracht.",
    "Sprecher 1: Wie ging es Ihnen damit?",
    "Sprecher 2: Am Anfang erleichtert, am Abend dann leer und schuldig, weil ich nichts geschafft habe.",
    "Sprecher 1: Dieses Schuldgefühl nach einem ruhigen Tag sollten wir genauer anschauen.",
    "Sprecher 2: Meine Mutter hat immer gesagt, Faulenzen sei der Anfang vom Ende.",
    "Sprecher 1: Ein Satz, der offenbar bis heute nachklingt.",
    "Sprecher 2: Ja, ich höre ihn jedes Mal, wenn ich mir eine Pause gönne.",
    "Sprecher 1: Für die nächste Woche schlage ich vor, eine Pause bewusst einzuplanen und aufzuschreiben, was dabei passiert.",
    "Sprecher 2: Das kann ich versuchen, auch wenn es sich im Moment seltsam anfühlt.",
]

BERICHT = [
    "Verlaufsbericht zuhanden der zuweisenden Hausärztin.",
    "Die Klientin, 42 Jahre, wurde im Februar wegen anhaltender Erschöpfung, Ein- und Durchschlafstörungen und sozialem Rückzug zugewiesen.",
    "Anamnestisch bestehen seit dem Stellenwechsel vor zwei Jahren eine hohe Arbeitsbelastung und wiederkehrende Konflikte im Team.",
    "Im Verlauf der bisherigen zwölf Sitzungen standen Psychoedukation, Schlafhygiene und die Arbeit an dysfunktionalen Leistungsüberzeugungen im Vordergrund.",
    "Die Klientin führt seit sechs Wochen ein Schlaftagebuch; die Einschlaflatenz hat sich von durchschnittlich neunzig auf etwa vierzig Minuten verkürzt.",
    "Weiterhin belastend sind familiäre Konflikte, insbesondere mit der älteren Schwester, die Entscheidungen ohne Rücksprache trifft.",
    "Suizidale Gedanken werden glaubhaft verneint, eine Absprachefähigkeit ist gegeben.",
    "Empfohlen wird die Fortführung der Behandlung mit wöchentlichen Sitzungen über weitere drei Monate sowie eine Überprüfung der Arbeitsfähigkeit.",
]


def long_text():
    """> 512 Tokens: ganzer Verlauf als Dialog."""
    return "\n".join(STORY)


def very_long_text():
    """> 1024 Tokens: Bericht, Verlauf und der Verlauf in umgekehrter Reihenfolge."""
    return "\n".join(BERICHT + STORY + list(reversed(STORY)) + BERICHT)


TEXTS = [
    ("anfrage-kurz", "Schlafprobleme wegen der Arbeit"),
    (
        "mundart",
        "Sprecher 2: I ha sit drei Wuche nümme rächt gschlafe, wil's im Gschäft eifach z'viel "
        "isch. Min Maa seit, i söll emol abschalte, aber das gaht nöd so eifach.",
    ),
    (
        "umlaute",
        "Übermässige Ängste vor Prüfungen: Herzrasen, Übelkeit und Schwindel – besonders "
        "früh morgens. «Ich hätte am liebsten alles abgesagt», sagt er; Grössenordnung ~3×/Woche.",
    ),
    ("bericht", " ".join(BERICHT[:4])),
    (
        "dialog",
        "Sprecher 1: Und wie war die Woche?\nSprecher 2: Schlecht, ich hab kaum geschlafen, weil "
        "im Büro so viel los war.\nSprecher 1: Was war denn los?\nSprecher 2: Die Abgabe am "
        "Freitag und dann noch der Streit mit meinem Kollegen.",
    ),
    ("lang-ueber-512", long_text()),
    ("lang-ueber-1024", very_long_text()),
    ("einzelwort", "Panikattacke"),
]


def b64(vector):
    import numpy as np

    return base64.b64encode(np.asarray(vector, dtype="<f4").tobytes()).decode("ascii")


def revision():
    hf_home = os.environ.get("HF_HOME", os.path.expanduser("~/.cache/huggingface"))
    ref = os.path.join(hf_home, "hub", "models--google--embeddinggemma-2", "refs", "main")
    try:
        with open(ref, encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return None


def main():
    if len(sys.argv) != 2:
        sys.exit("Usage: make-search-golden.py <ausgabe.json>")
    out_path = sys.argv[1]

    import sentence_transformers
    import torch
    from sentence_transformers import SentenceTransformer

    model = SentenceTransformer(
        MODEL_ID,
        device="cpu",
        model_kwargs={"torch_dtype": torch.float32},
        config_kwargs={"vision_config": None, "audio_config": None},
    )
    model.max_seq_length = MAX_TOKENS
    tokenizer = model.tokenizer

    texts = [text for _, text in TEXTS]
    queries = model.encode(texts, prompt=QUERY_PROMPT, normalize_embeddings=True, batch_size=1)
    documents = model.encode(texts, prompt=DOCUMENT_PROMPT, normalize_embeddings=True, batch_size=1)

    entries = []
    for (text_id, text), q, d in zip(TEXTS, queries, documents):
        tokens = len(tokenizer(DOCUMENT_PROMPT + text)["input_ids"])
        entries.append(
            {
                "id": text_id,
                "text": text,
                "documentTokens": tokens,
                "documentTokensUsed": min(tokens, MAX_TOKENS),
                "query": b64(q),
                "document": b64(d),
            }
        )

    golden = {
        "model": MODEL_ID,
        "revision": revision(),
        "reference": (
            f"sentence-transformers {sentence_transformers.__version__}, "
            f"torch {torch.__version__}, float32, cpu"
        ),
        "queryPrompt": QUERY_PROMPT,
        "documentPrompt": DOCUMENT_PROMPT,
        "maxTokens": MAX_TOKENS,
        "dim": int(queries.shape[1]),
        "encoding": "base64 float32 little-endian, L2-normalisiert",
        "texts": entries,
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(golden, f, ensure_ascii=False, indent=2)
        f.write("\n")
    for entry in entries:
        print(f"{entry['id']}: {entry['documentTokens']} Tokens")
    print(f"→ {out_path}")


if __name__ == "__main__":
    main()
