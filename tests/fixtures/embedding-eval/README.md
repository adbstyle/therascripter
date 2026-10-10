# Embedding-Eval: lokale semantische Suche über Sitzungen

Vergleich lokal laufender Embedding-Modelle für eine semantische Suche in Therascript.
Skript: `scripts/eval-embeddings.py`, Abhängigkeiten: `scripts/eval-embeddings-requirements.txt`
(eigenes Venv, nie `python_sidecar/venv`).

## Ergebnis (Stand 2026-10-10, Mac17,8 / 64 GB, MPS)

nDCG@10 bei Chunks von ~200 Wörtern, 91 Anfragen mit Treffern, 95-%-Bootstrap-Intervall:

| Modell | nDCG@10 | 95-%-KI | Δ zum Besten (KI) | Hit@5 | Neg-AUC | Lizenz |
|---|---|---|---|---|---|---|
| `google/embeddinggemma-300m` | **0.640** | 0.593–0.685 | – | 0.84 | 0.93 | Gemma ToU |
| `microsoft/harrier-oss-v1-0.6b` | 0.593 | 0.538–0.648 | −0.088 … −0.008 | 0.82 | 0.86 | MIT |
| `BAAI/bge-m3` | 0.580 | 0.527–0.634 | −0.099 … −0.018 | 0.86 | 0.79 | MIT |
| `Qwen/Qwen3-Embedding-0.6B` | 0.573 | 0.516–0.629 | −0.108 … −0.026 | 0.79 | 0.91 | Apache 2.0 |
| `microsoft/harrier-oss-v1-270m` | 0.548 | 0.492–0.603 | −0.133 … −0.054 | 0.84 | 0.88 | MIT |
| `ibm-granite/granite-embedding-311m-multilingual-r2` | 0.502 | 0.441–0.560 | −0.189 … −0.092 | 0.70 | 0.91 | Apache 2.0 |
| BM25 (Stichwortsuche) | 0.459 | 0.393–0.524 | −0.251 … −0.111 | 0.67 | 0.87 | – |

- EmbeddingGemma ist signifikant besser als alle anderen (Δ-Intervall schliesst 0 aus).
  Unter den Embedding-Modellen liegt es in vier von sechs Anfrage-Typen vorne. Ausnahmen:
  Fakten (Harrier 0.6B 0.73 vs. 0.71) und Mundart (bge-m3 0.60 vs. 0.53, nur 8 Anfragen).
  Bei Stichwort-Anfragen ist BM25 knapp besser (0.79 vs. 0.76).
- Harrier 0.6B ist bei Mundart schwach (0.29), ebenso Qwen3 (0.37).
- Chunk-Grösse: Die Rangfolge Gemma > Harrier 0.6B hält bei 100 und 300 Wörtern (bei 300
  Wörtern ist der Abstand nicht mehr signifikant). Die Werte verschiedener Chunk-Grössen
  sind untereinander nicht vergleichbar (grössere Chunks enthalten mehr Units).
- Hybrid (Reciprocal Rank Fusion mit BM25, gleich gewichtet, explorativ) verschlechtert
  alle starken Modelle. Es hilft nur bei Stichwort-Anfragen (Gemma 0.76 → 0.81).
- Neg-AUC: wie gut der Ähnlichkeitswert des besten Treffers Anfragen mit und ohne Treffer
  trennt (1.0 = perfekt). Gemma 0.93 macht einen Schwellwert für «nichts gefunden»
  realistisch.

### Praxis (Zuwachs `phys_footprint` über den Prozess-Sockel)

| Modell | dtype | Gewichte | Peak Laden | Peak Indexieren (sparsam) | 45-min-Sitzung indexieren |
|---|---|---|---|---|---|
| embeddinggemma-300m | fp32 (fp16 nicht unterstützt) | 1.15 GB | 1.50 GB | 2.55 GB | 1.5 s |
| harrier-0.6b | fp16 | 1.11 GB | 2.32 GB | 2.36 GB | 1.9 s |
| bge-m3 | fp16 (Checkpoint fp32) | 2.12 GB | 2.40 GB | 3.47 GB | 0.9 s |
| qwen3-0.6b | fp16 | 1.11 GB | 2.32 GB | 2.36 GB | 2.1 s |
| harrier-270m | fp32 (fp16 → NaN) | 0.50 GB | 1.94 GB | 2.71 GB | 1.5 s |
| granite-311m-r2 | fp16 | 0.58 GB | 1.88 GB | 1.91 GB | 0.5 s |

«Sparsam» bedeutet Batch 4 und `torch.mps.empty_cache()` nach jedem Batch, so wie es
`ner_service.py` macht. Die Messwerte enthalten einen Lade-Overhead: sentence-transformers
lädt zuerst auf die CPU und kopiert dann auf MPS, die CPU-Kopie bleibt im Footprint
(gemessen bei harrier-0.6b: 1.66 GB im Ruhezustand bei 1.11 GB Gewichten). Eine App-
Implementierung kann das vermeiden. Die Indexierzeit ist bei allen Modellen
vernachlässigbar.

### Entscheidung (2026-10-10): EmbeddingGemma 300M

Bedingungen: Lizenz MIT/Apache (Gemma ToU nur bei klarem Vorsprung, d. h. das Δ-Intervall
jedes anderen Modells liegt unter 0), absoluter Prozess-Peak im sparsamen Modus
≤ 3.5 GiB, Indexierung einer 45-min-Sitzung ≤ 20 s. Gewinner ist das beste nDCG@10 unter
den Modellen, die alle Bedingungen erfüllen. Erfüllt werden sie von allen Modellen ausser
bge-m3 (3.81 GiB). Gewinner ist EmbeddingGemma (2.90 GiB absolut).

- **Speicher-Schwelle geändert:** Vorab galten ≤ 2 GB Zuwachs, streng angewendet hätte nur
  granite-311m-r2 bestanden. Die Schwelle war gesetzt, bevor bekannt war, dass der Footprint
  pro Modell rund 0.5–1 GB Lade-Overhead enthält. Weil die Modelle strikt nacheinander
  laufen, zählt der Pipeline-Peak; der liegt heute mit flair-NER bei ~3.5 GiB. Die neue
  Schwelle ist «nicht über dem NER-Peak».
- **Lizenz:** Die Ausnahme für EmbeddingGemma greift, weil der Vorsprung signifikant ist.
  Vor der Auslieferung muss geklärt sein, wie die Gemma-Nutzungsbedingungen an die Nutzer
  weitergegeben werden und ob die Prohibited Use Policy für den Therapie-Kontext passt.
- **Für die Umsetzung:** nur fp32 oder bf16 (fp16 liefert NaN, siehe Model Card), Prompts
  `task: search result | query: ` für Anfragen und `title: none | text: ` für Abschnitte,
  max. 2048 Tokens, Matryoshka-Dimensionen 768/512/256/128 möglich (nicht getestet).

## Design

- **Korpus:** 10 synthetische Therapiesitzungen (`sessions/`, 4 fiktive Klient:innen,
  je ~2500 Wörter, Transkriptstil mit Helvetismen und absichtlichen Ablenkungen) plus 3
  SRF-«Input»-Podcasts (`podcast/`, gitignored), transkribiert mit pyannote
  community-1 und whisper large-v3-turbo-swiss ohne Stitching. Total 1387 Units und
  ~45'000 Wörter. Die Podcasts liefern echte ASR-Fehler, darunter eine bekannte
  Whisper-Halluzination am Schluss einer Folge.
- **Units und Chunks:** Ein Unit ist ein Redebeitrag, Beiträge über 120 Wörter werden an
  Satzgrenzen geteilt. Chunks fassen Units zu ~200 Wörtern zusammen, mit einem kurzen Unit
  Überlappung. Bewertet wird auf Units, ein Chunk erbt die höchste Note seiner Units. So
  bleiben die Bewertungen bei anderen Chunk-Grössen gültig.
- **Anfragen (`queries.jsonl`):** 99, davon 8 negative. Typen: Umschreibung, thematisch,
  Fakten, Stichwort, Mundart, übergreifend, negativ. Geschrieben vor dem ersten Lauf.
- **Relevanz (`qrels.jsonl`):** Unabhängige Bewerter-Agents haben pro Dokument jede Unit
  gegen jede Anfrage geprüft (0/1/2). Danach folgte ein Pooling: 787 Top-3-Treffer aller
  Läufe ohne relevante Unit wurden verblindet nachgeprüft. Das ergab 31 neue Bewertungen
  mit Note 1 und keine mit Note 2.
- **Modelle:** Prompts exakt aus `config_sentence_transformers.json` der Hersteller, max.
  1024 Tokens (kein Chunk wurde abgeschnitten), fp16 auf MPS, ausser bei Modellen mit
  NaN in fp16 (automatischer Neustart in fp32 in einem frischen Prozess).
- **Speicher:** `phys_footprint` via `proc_pid_rusage`, Lade- und Indexier-Peak über
  `proc_reset_footprint_interval` getrennt, jedes Modell in einem eigenen Prozess.

## Grenzen

- Es gibt keine echten Therapie-Transkripte. Korpus, Anfragen und Bewertungen stammen von
  Sprachmodellen, als Kontrolle dienen BM25 (deutlich schlechter, die Anfragen sind also
  nicht nur wörtlich lösbar) und die Stichprobe, die Adrian vor dem Lauf geprüft hat.
- Mit 205 Chunks ist das Korpus klein, ein echter Index mit hunderten Sitzungen ist
  schwerer. Die absoluten Werte sind deshalb optimistisch, die Rangfolge ist belastbar.
- Gemessen wurde auf einem 64-GB-Mac. Das Verhalten auf 8 GB ist aus dem Footprint
  abgeleitet, nicht gemessen.

## Reproduzieren

```bash
PY=<eval-venv>/bin/python
scripts/fetch-test-podcasts.sh
# Podcasts mit diarize.py + whisper-cli transkribieren (RTTM + <name>.wav.json), dann:
$PY scripts/eval-embeddings.py podcast-turns --rttm-dir <dir> --whisper-dir <dir>
HF_HOME=<cache> $PY scripts/eval-embeddings.py run --all [--target-words 200]
$PY scripts/eval-embeddings.py report --hybrid
```
