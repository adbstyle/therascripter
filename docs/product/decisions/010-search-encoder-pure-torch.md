# ADR-010: Text-Encoder der Suche in reinem torch statt sentence-transformers

**Status:** Accepted
**Datum:** 2026-11-14
**Kontext-Issues:** Epic #192, #209 (Python-Suchdienst und Modell-Paket)
**Ergänzt:** [ADR-008](008-semantic-search-embedding.md) (Modellwahl)

## Kontext

Die Suche nach Bedeutung braucht Vektoren aus EmbeddingGemma 2 (`google/embeddinggemma-2`, ADR-008 mit Nachtrag). Laufen soll das Modell im vorhandenen Python-Sidecar, dessen Standalone-Umgebung torch 2.10, tokenizers 0.22 und safetensors 0.7 schon mitbringt.

Die naheliegenden Wege scheitern an den Abhängigkeiten (gemessen im Bauplan der Suche):

- **sentence-transformers** ab 6.1 verlangt `transformers>=5`. **flair 0.15.1**, die neueste Version und Grundlage der Pseudonymisierung (ADR-004), verlangt `transformers<5`. `uv pip compile` findet keine gemeinsame Lösung.
- **transformers 5 ohne sentence-transformers** hilft nicht: die Modellklasse (`model_type: embedding_gemma2`) gibt es erst ab transformers 5.

## Entscheidung

Der Text-Encoder wird in reinem torch nachgebaut: `python_sidecar/search_service.py`, nachgebaut nach `modeling_embedding_gemma2.py` aus Hugging Face transformers (Apache-2.0, Herkunft im Kopfkommentar). Pooling und Normalisierung folgen dem sentence-transformers-Modell des Originals (Mean-Pooling über die Maske inklusive Prompt, dann L2). Die Projektion 512 → 768 ist Teil des Modells.

Gegen stille Abweichungen sichern **Goldvektoren** ab: `scripts/make-search-golden.py` berechnet sie mit sentence-transformers in fp32 auf der CPU aus dem Original-Modell, für acht erfundene Texte (Mundart, Umlaute, > 512 und > 1024 Tokens), je als Anfrage und als Dokument (`tests/fixtures/search-golden/golden.json`). Der Modus `selftest` vergleicht dagegen, geprüft im Smoke-Check `search parity` und im Vitest mit Modell.

| Messung (M5 Pro, 64 GB) | Wert |
|---|---|
| fp32 auf der CPU gegen Goldvektoren | Kosinus 1.0 auf 9 Stellen (alle 16 Vektoren); Schwelle 0.9999995 |
| bf16 auf MPS gegen Goldvektoren | Kosinus min. 0.9999147 |
| Zusätzliches Bundle | 0 MB (nur `safetensors`, `tokenizers`, `numpy` explizit in `requirements.txt`, ohne Versionswechsel) |
| Import bis bereit | ~3–7 s je nach Datei-Cache und Last (Import ~1–2 s) |
| phys_footprint nach Laden | ~1.5 GiB; beim Aufbereiten kurzer Läufe (≤ 148 Abschnitte) ~2.1 GiB |
| Dauerlauf 2000 Anfragen auf MPS | +827 Bytes pro Forward-Pass (ohne Autorelease-Pool ~100 KiB) |
| Abnahme auf dem Referenz-Set (PR S6, mit int8-Vektoren der App) | nDCG@10 0.568 gegenüber 0.570 mit sentence-transformers; bester Abschnitt bei 131 von 136 Anfragen gleich |

Die Gewichte kommen als eigenes Text-Artefakt (`scripts/export-search-model.py`, `scripts/package-models.sh search`): nur die 413 Tensoren `language_model.*` in bf16, 542 MB statt 1.49 GB, reproduzierbar gepackt.

## Alternativen

| Weg | Ergebnis | Entscheid |
|---|---|---|
| Overlay: transformers 5 + 27 Abhängigkeiten per `PYTHONPATH` vor dem Standalone | funktioniert, ~100 MB, fp32 identisch; Import aber 4.6–4.9 s, eine erste Suche bliebe über 5 s | Rückfallebene |
| Zweite vollständige Python-Umgebung | torch doppelt, geschätzt +600–700 MB | verworfen |
| GGUF über das gebündelte llama.cpp (b9200) | kennt EmbeddingGemma 2 nicht (andere Architektur als `gemma-embedding`), neuere Builds brechen `--json-schema` | verworfen |
| transformers 5 ohne sentence-transformers | löst den Konflikt mit flair nicht | verworfen |

## Folgen

- **Pflege:** Der Nachbau gilt für genau ein Artefakt (Modell-ID und Ordner tragen die Version). Ein anderes Modell braucht neue Goldvektoren und gegebenenfalls einen neuen Nachbau; die Goldvektoren schlagen an, bevor falsche Vektoren in einen Index gelangen.
- **Präzision:** bf16 auf MPS, nie fp16 (Gemma läuft in fp16 über). Auf der CPU fp32: bf16 ist dort sehr langsam (15.9 s für 8 Texte). Rückfall nach MPS-OOM: erst `.to('cpu')`, dann `.float()` (NER-Gotcha).
- **Prüfschärfe:** Auf MPS verdeckt das bf16-Rauschen Off-by-one-Fehler im Encoder (Sliding Window 511/513, Kürzung 1023: weiterhin ≥ 0.99992). Deshalb laufen Smoke und Vitest den Selftest zusätzlich in fp32 auf der CPU mit Schwelle 0.9999995 — dieselben Fehler fallen dort auf 0.99993–0.999998 und werden rot.
- **Speicher:** Aufgefüllt wird pro Batch auf Vielfache von 128 Tokens, höchstens 2 Texte und 2048 Token-Slots pro Batch. Ohne Raster 3.9 GiB `phys_footprint`, mit Raster 1.8 GiB; vier Texte à 1024 Tokens kamen auf 3.4 GiB, zwei auf 1.8 GiB. Jeder Forward-Pass läuft in einem Objective-C-Autorelease-Pool; ohne ihn wuchs der Prozess auf MPS um ~100 KiB pro Pass. Jede Antwort meldet `phys_footprint_bytes`, der Aufrufer startet den Dienst ab einer Schwelle neu.
- **Protokoll:** ein langlebiger Prozess (JSON-Lines, `serve`) für Anfragen und Aufbereitung; stdout trägt nur Protokollzeilen. Python bleibt zustandslos, Node hält die Vektoren (Bauplan, Epic #192).
- **Lizenz:** Der nachgebaute Code und das Modell stehen unter Apache-2.0; Einträge in `THIRD_PARTY_LICENSES.md`.
