# Referenz-Set der Suche (Spike #208)

Fester Massstab für die semantische Suche aus Epic #192: Abnahme der Suche gegen den
Zielwert unten, plus Messwerte zu Speicher und Antwortzeit. Alles hier ist erfunden —
Personen, Orte, Inhalte. Messskript: `scripts/search-spike.py` (Ablauf im Kopf des Skripts).

## Inhalt

| Pfad | Inhalt |
|---|---|
| `sessions/*.txt` | 10 fiktive Therapiesitzungen, 4 Klient:innen (a: Sandra Meier, b: Marco Rüegg, c: Leonie Kunz, d: Fatma Yilmaz), je 2'400–2'800 Wörter, Schweizer Hochdeutsch mit Mundart-Einsprengseln |
| `reports/*.txt` | 4 fiktive PDF-Berichte, je einer pro Klient:in (Zuweisung, Konsiliarbericht, Ernährungsberatung, Hebamme) |
| `entities/*.json` | Personen, Orte und Institutionen jedes Dokuments mit Platzhalter-Typ |
| `pseudo/*.txt` | dieselben Dokumente pseudonymisiert (`[PERSON 1]`, `[ORT 1]` …), erzeugt mit `search-spike.py pseudonymize` |
| `queries.jsonl` | 136 Anfragen: 126 mit Treffern, 10 ohne (`negativ`) |
| `qrels.jsonl` | 1'148 Relevanzurteile (Anfrage, Unit, Note 1 oder 2); fehlendes Paar = Note 0 |
| `RATER.md` | Wortlaut der Bewertungsanleitung für die Relevanzurteile |
| `qrels-parts/` | Rohurteile je Bewertungsdurchgang, mit `search-spike.py merge-qrels` zusammengeführt |
| `results/` | Messwerte des gewählten Modells; `results/embeddinggemma-300m/` zum Vergleich |

Anfragen je Art: Umgangssprache/Mundart 23, Fakten 22, Klarname 18, PDF-Bericht 18,
thematisch 16, Paraphrase 12, übergreifend 9, Stichwort 8, negativ 10. 81 Anfragen stammen
aus der Modell-Evaluation (ADR-008, `origin: eval-2026-10`); für #208 kamen 18 Klarnamen-,
18 Bericht-, 16 Mundart- und 3 Anfragen ohne Treffer dazu (`origin: spike-208`).

Klarnamen-Anfragen beziehen sich auf den Originaltext (`sessions/`, `reports/`); gesucht
wird die Fundstelle im Originaltext. Die pseudonymisierte Fassung (`pseudo/`) liegt daneben,
damit eine spätere Suche über beide Fassungen gegen dasselbe Set geprüft werden kann.

## Herkunft der Relevanzurteile

1. **Erschöpfend pro Dokument:** Sprachmodell-Agents (Claude) haben jede Unit jedes
   Dokuments gegen jede Anfrage bewertet, die dem Dokument zugewiesen ist, ohne Suchergebnisse
   gesehen zu haben. Skala: 2 = die gesuchte Stelle, 1 = teilweise relevant, 0 = nicht relevant.
   Bei Klarnamen zählt jede Nennung der Person in jeder Schreibform; bei gleichen Namen
   verschiedener Personen alle.
2. **Nachprüfung der Top-Treffer (Pooling):** Units in den Top-3-Abschnitten jedes Modells,
   die noch kein Urteil hatten, wurden verblindet (ohne Rang und ohne Modellnamen) nachbewertet —
   für embeddinggemma-300m 1'640 Paare (79 relevant), für EmbeddingGemma 2 1'297 Paare
   (27 teilweise, keines voll relevant). Paare aus der Nachprüfung eines früheren Modells
   werden nicht erneut vorgelegt. Die Listen stehen in `results/pool-audit-<modell>.jsonl`,
   erzeugt mit `search-spike.py pool`; die Anleitung für beide Durchgänge in `RATER.md`.
3. **Stichprobe durch den Product Owner:** jede fünfte Anfrage (28 von 136) mit allen
   bewerteten Stellen in `results/po-review.md`; Ergebnis pro Anfrage in
   `results/po-review.jsonl`. **Stand: offen.**

## Messwerte (EmbeddingGemma 2)

Modell `google/embeddinggemma-2` (Apache 2.0), nur Text-Teil, bf16, Prompts der Model Card,
Abschnitte à ~200 Wörter. Gemessen am 2026-11-14 auf einem Mac mit M5 Pro und 64 GB RAM,
sentence-transformers 6.3.0, torch 2.15.0. Speicher als `phys_footprint` (inkl. Grafikspeicher),
jede Messung in einem frischen Prozess.

### Trefferqualität

| | EmbeddingGemma 2 | embeddinggemma-300m (Vergleich) |
|---|---|---|
| nDCG@10 gesamt | **0.570** (95 %-CI 0.521–0.617) | 0.658 (0.620–0.697) |
| Hit@5 | 0.79 | 0.86 |
| Trennung Anfragen ohne Treffer (AUC) | 0.70 | 0.82 |
| Wiederholung, frischer Prozess | 0.570, gleich auf zwei Nachkommastellen | gleich |

Je Anfrageart (nDCG@10): Klarname 0.66 · Bericht 0.64 · Fakten 0.63 · Stichwort 0.61 ·
thematisch 0.54 · Paraphrase 0.53 · Umgangssprache 0.47 · übergreifend 0.40.

Der Vergleichswert von 300m ist vor der zweiten Nachprüfung gemessen (27 Urteile weniger).

**Zielwert für die Abnahme der Suche: nDCG@10 ≥ 0.52** — untere Grenze des 95 %-CI
(Bootstrap über die Anfragen) des Gesamtwerts, auf zwei Stellen abgerundet. Er gilt für dieses
Set in diesem Stand; wer Anfragen oder Urteile ändert, misst und setzt ihn neu.

### Speicher und Antwortzeit

Bestand: 2'000 Einträge, davon jeder zehnte ein PDF-Bericht, Sitzungen in der Länge von
50 Minuten (7'550 Wörter), zusammengesetzt aus Abschnitten des Referenz-Sets — 66'110 Abschnitte,
Index 194 MiB. Liegt ausserhalb des Repos (`~/.cache/therascript-search-spike/`), erzeugt mit
`search-spike.py bench-corpus`.

| | Grafikchip (MPS) | Prozessor, 4 Kerne | Grenze |
|---|---|---|---|
| Speicher-Spitze beim Aufbereiten einer Sitzung | 1.87 GiB | 1.12 GiB | 3.5 GiB |
| Dauer Aufbereiten einer Sitzung (~7'600 Wörter) | 2.9 s | 124 s | – |
| Speicher-Spitze bei der Suche über 2'000 Einträge | 2.21 GiB | 1.12 GiB | 3.5 GiB |
| Weitere Suchen, Median / Maximum (30 Suchen) | 0.03 / 0.04 s | 0.09 / 0.11 s | 2 s |
| Erste Suche nach dem Start | 5.9 s | 4.8 s | (2 s) |

Die erste Suche besteht fast ganz aus dem Laden des Modells (5.3 s bzw. 4.4 s); Index laden
0.2 s, Suche 0.1–0.2 s.

### Ableitung für einen Mac mit 8 GB RAM

- **Speicher: ≤ 3.5 GiB erfüllt** (Spitze 2.21 GiB). Annahme: Der Speicherbedarf eines
  Prozesses hängt an Modell und Index, nicht am RAM des Geräts; gemessen wurde ohne Speicherdruck.
- **Weitere Suchen: < 2 s erfüllt** (langsamste von 30 Suchen 0.11 s auf dem Prozessor). Annahme:
  Ein M1 rechnet um höchstens Faktor 4 langsamer als der Messrechner; selbst Faktor 10 bliebe
  bei 1 s.
- **Erste Suche: über 2 s** — schon auf dem Messrechner 4.8–5.9 s, auf einem 8-GB-Mac mit
  Swap länger, weil das Laden des Modells (1.4 GB Gewichte) an der Platte hängt. Laut Story
  entscheidet der Product Owner.
- **Nicht gemessen** (Out of Scope): auf einem echten 8-GB-Mac, neben einer laufenden
  Verarbeitung, Dauer des erstmaligen Aufbereitens des ganzen Bestands.

### Hinweise für die Umsetzung

- Auf dem Prozessor rechnet bf16 sehr langsam (124 s statt 2.9 s pro Sitzung). Braucht die
  Suche eine Ausweichlösung ohne Grafikchip, lädt sie das Modell dort in fp32 — Speicher und
  Dauer dafür sind nicht gemessen. fp16 ist für dieses Modell nicht zulässig (Model Card).
- Nur der Text-Teil laden (`config_kwargs={"vision_config": None, "audio_config": None}`):
  271M statt 744M Parameter, identische Embeddings. Die Gewichtsdatei auf Hugging Face enthält
  trotzdem Bild- und Audio-Teil (1.4 GB).
- sentence-transformers lädt den Prozessor des Modells mit Bildprozessor; dafür braucht es
  Pillow und torchvision, auch für reinen Text.

## Messung wiederholen

```bash
uv venv --python 3.12 <dir> && VIRTUAL_ENV=<dir> uv pip install -r scripts/search-spike-requirements.txt
<dir>/bin/python scripts/search-spike.py quality
<dir>/bin/python scripts/search-spike.py bench-index
<dir>/bin/python scripts/search-spike.py bench-corpus
<dir>/bin/python scripts/search-spike.py bench-search
<dir>/bin/python scripts/search-spike.py report
```
