# ADR-008: EmbeddingGemma 300M für eine lokale semantische Suche

**Status:** Accepted, Umsetzung zurückgestellt
**Datum:** 2026-10

## Kontext

Therapeut:innen sollen ihre Sitzungen über die Bedeutung durchsuchen können («Wo ging es um Schuldgefühle gegenüber der Mutter?»), nicht nur über exakte Wörter. Dafür braucht es ein Embedding-Modell, das Abschnitte und Suchanfragen in Vektoren übersetzt.

Anforderungen:
- **Lokal:** wie bei ASR, Diarization und NER. Ein Cloud-Embedding (z. B. Infomaniak) bleibt technisch möglich, die Vektoren sind aber nicht anonym, und jeder Modellwechsel des Anbieters erzwänge eine Neuindexierung aller Sitzungen.
- **Deutsch und Schweizer Transkripte:** gesprochene Sprache, Helvetismen, ASR-Fehler.
- **8-GB-Macs:** Der Prozess-Peak darf den heutigen Pipeline-Peak nicht übersteigen. Der liegt bei ~3.5 GiB und wird von flair-NER erreicht (ADR-004); die Modelle laufen strikt nacheinander.
- **Lizenz:** MIT oder Apache 2.0, eine andere nur bei klarem Qualitätsvorsprung.

## Voraussetzungen vor der Umsetzung

Eine Suche lohnt sich erst, wenn es etwas zu durchsuchen gibt:
1. Sitzungen lassen sich zu Patientendossiers zusammenfassen (Klient-Entität), sonst gibt es keine sitzungsübergreifende Suche pro Person.
2. Die 30-Tage-Auto-Löschung (`SessionService.cleanupOldSessions`) ist entfernt oder ersetzt, sonst ist der Index nie älter als 30 Tage.

## Entscheidung

**`google/embeddinggemma-300m`** (308 Mio. Parameter, 768 Dimensionen, Kontext 2048 Tokens).

Für die Umsetzung gilt:
- Rechnen nur in fp32 oder bf16. fp16 liefert NaN; die Model Card dokumentiert das.
- Prompts: `task: search result | query: ` vor Anfragen, `title: none | text: ` vor Abschnitten.
- Abschnitte von ~200 bis 300 Wörtern, gebildet aus Sprecherbeiträgen, mit einem kurzen Beitrag Überlappung.
- GPU-Cache nach jedem Batch freigeben, wie in `ner_service.py` (`_release_mps_cache`).
- Die Gewichte direkt auf das Zielgerät laden. sentence-transformers lädt sonst zuerst auf die CPU, und die CPU-Kopie bleibt im Speicher.
- Matryoshka-Dimensionen 512/256/128 sind möglich, um Speicherplatz zu sparen. Sie wurden nicht getestet.

## Evaluation

Am 2026-10-10 wurden sechs lokale Modelle und BM25 (reine Stichwortsuche) verglichen. Das Hauptmass ist nDCG@10: wie gut die ersten zehn Treffer sortiert sind, 1.0 heisst ideal. Dazu kommen ein 95-%-Bootstrap-Intervall und als «Δ zum Besten» das Intervall der Differenz zu EmbeddingGemma, gepaart pro Anfrage.

| Modell | nDCG@10 (95-%-KI) | Δ zum Besten | Prozess-Peak | Lizenz |
|---|---|---|---|---|
| **google/embeddinggemma-300m** | **0.640** (0.59–0.69) | – | 2.09 GiB | Gemma ToU |
| microsoft/harrier-oss-v1-0.6b | 0.593 (0.54–0.65) | −0.09 … −0.01 | 3.14 GiB | MIT |
| BAAI/bge-m3 | 0.580 (0.53–0.63) | −0.10 … −0.02 | 3.53 GiB | MIT |
| Qwen/Qwen3-Embedding-0.6B | 0.573 (0.52–0.63) | −0.11 … −0.03 | 3.17 GiB | Apache 2.0 |
| microsoft/harrier-oss-v1-270m | 0.548 (0.49–0.60) | −0.13 … −0.05 | 3.02 GiB | MIT |
| ibm-granite/granite-embedding-311m-multilingual-r2 | 0.502 (0.44–0.56) | −0.19 … −0.09 | 2.07 GiB | Apache 2.0 |
| BM25 | 0.459 (0.39–0.52) | −0.25 … −0.11 | – | – |

Der Prozess-Peak ist der absolute `phys_footprint` beim Indexieren mit Batch 4 und `empty_cache` pro Batch, gemessen in einem frischen Prozess auf einem Mac17,8 mit 64 GB. Eine 45-min-Sitzung (~6800 Wörter) ist mit jedem Modell in höchstens 2.2 s indexiert.

**Weitere Befunde:**
- EmbeddingGemma ist signifikant besser als jedes andere Modell (alle Δ-Intervalle liegen unter 0). Unter den Embedding-Modellen führt es in vier von sechs Anfrage-Typen. Die Ausnahmen: Fakten-Fragen (Harrier 0.6B 0.73 vs. 0.71) und Mundart-Anfragen (bge-m3 0.60 vs. 0.53, nur 8 Anfragen).
- Harrier 0.6B (0.29) und Qwen3 (0.37) sind bei Mundart-Anfragen schwach. Für Schweizer Transkripte ist das ein Warnsignal.
- EmbeddingGemma trennt Anfragen mit und ohne Treffer am besten (Neg-AUC 0.93). Ein Schwellwert für «nichts gefunden» ist damit realistisch.
- Eine Kombination mit BM25 (Reciprocal Rank Fusion, gleich gewichtet) verschlechtert alle starken Modelle. Sie hilft nur bei exakten Stichwörtern (0.76 → 0.81).
- Bei 100 und 300 Wörtern pro Abschnitt bleibt die Rangfolge gleich; bei 300 Wörtern ist der Abstand zu Harrier nicht mehr signifikant.

**Methode:**
- **Korpus:** 10 synthetische Sitzungen mit 4 fiktiven Klient:innen, im Transkriptstil, mit Helvetismen und absichtlichen Ablenkungen (z. B. «schläft schlecht wegen Baby» neben «schläft schlecht wegen Angst»). Dazu 3 SRF-«Input»-Podcasts, durch pyannote und whisper transkribiert, mit echten ASR-Fehlern. Zusammen ~45'000 Wörter.
- **Anfragen:** 99 Anfragen in sieben Typen: Umschreibung, thematisch, Fakten, Stichwort, Mundart, übergreifend und negativ (8 Anfragen ohne Treffer). Sie wurden vor dem ersten Lauf festgelegt.
- **Relevanz:** Unabhängige Bewerter haben pro Dokument jeden Sprecherbeitrag gegen jede Anfrage bewertet (0/1/2). Danach wurden 787 Top-3-Treffer aller Läufe, die keine relevante Stelle enthielten, verblindet nachgeprüft. Das ergab nur 31 zusätzliche Bewertungen mit Note 1.

**Grenzen:**
- Echte Therapie-Transkripte gab es nicht, und Korpus, Anfragen und Bewertungen stammen von Sprachmodellen. Als Kontrolle diente BM25: Es schneidet deutlich schlechter ab, die Anfragen sind also nicht bloss wörtlich lösbar.
- Das Korpus ist klein (205 Abschnitte). Die absoluten Werte fallen deshalb zu optimistisch aus, die Rangfolge ist belastbar.
- 8-GB-Macs wurden nicht gemessen. Ihr Verhalten ist aus dem Footprint abgeleitet.

**Reproduzieren:** Skript, Korpus, Anfragen und Bewertungen liegen in Commit `c16276b` (Branch `feat/embedding-eval`, PR #159): `scripts/eval-embeddings.py` und `tests/fixtures/embedding-eval/`. Die Podcast-Audios holt `scripts/fetch-test-podcasts.sh`.

## Begründung

- **Qualität:** Bester Wert über fast alle Anfrage-Typen und signifikant vor allen Alternativen, und das bei der halben Grösse der 0.6B-Modelle.
- **Speicher:** Mit 2.09 GiB hat es unter den guten Modellen den geringsten Prozess-Peak. Der Abstand zum NER-Peak ist gross, obwohl es nur in fp32 läuft.
- **Lizenz-Ausnahme:** Der Vorsprung ist signifikant gegenüber jedem anderen Modell. Ein MIT-Modell (Harrier 0.6B) wäre schlechter und schwach bei Mundart.
- **Alternative verworfen, Cloud-Embedding** (Infomaniak bge-multilingual-gemma2 / Qwen3-Embedding-8B): Die Vektoren sind nicht anonym, und es gäbe kein Offline-Suchen. Nimmt der Anbieter ein Modell aus dem Katalog, müssen alle Sitzungen neu indexiert werden.
- **Alternative verworfen, bge-m3:** Gut bei Mundart, aber insgesamt signifikant schlechter und mit 3.53 GiB über dem Pipeline-Peak.

## Konsequenzen

- **Lizenz vor Auslieferung klären:** Die Gemma Terms of Use müssen beim Modell-Download (R2) an die Nutzer:innen weitergegeben werden. Die Prohibited Use Policy ist für den Therapie-Kontext zu prüfen; für eine Suche in den eigenen Notizen ist kein Konflikt erkennbar.
- **Download:** ~1.2 GB, fp32 auf der Platte. Das Modell wäre wie die Zusammenfassung ein optionales Modell im Katalog, nicht Teil des Erststart-Downloads.
- **Runtime:** Es läuft im Python-Sidecar über sentence-transformers. torch und transformers sind dort schon vorhanden, sentence-transformers käme als Abhängigkeit hinzu (`requirements.txt`, Standalone-Build).
- **Index:** Die Vektoren landen pro Abschnitt als BLOB in SQLite. Bei einigen tausend Abschnitten reicht eine Kosinus-Rechnung in Node, eine Vektordatenbank braucht es nicht. Ein Modellwechsel erzwingt eine Neuindexierung.
- **Datenschutz:** Die Vektoren sind wie der Klartext zu behandeln, denn der Text lässt sich teilweise aus ihnen rekonstruieren. Für sie gelten dieselben Lösch- und Speicherregeln wie für die Sitzungen.
