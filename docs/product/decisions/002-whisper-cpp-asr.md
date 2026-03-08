# ADR-002: whisper.cpp für Spracherkennung

**Status:** Accepted
**Datum:** 2025-02

## Kontext

Therascript benötigt ein ASR-Modell (Automatic Speech Recognition) für die Transkription von Therapiesitzungen auf Deutsch und Schweizerdeutsch. Das Modell muss lokal auf Apple Silicon laufen, Word-Timestamps für Speaker-Alignment liefern und innerhalb des 8 GB RAM-Budgets bleiben. Die Verarbeitungszeit soll maximal 2x Echtzeit betragen (NFR-3).

## Entscheidung

whisper.cpp (C++) mit dem Modell Whisper Large V3 Turbo in Q5_0-Quantisierung wird als Subprocess aufgerufen. Metal GPU-Beschleunigung auf Apple Silicon ist aktiviert.

| Eigenschaft | Wert |
|-------------|------|
| Modell | whisper-large-v3-turbo (809M Parameter) |
| Runtime | whisper.cpp (C++, Metal GPU) |
| Quantisierung | Q5_0 (~1.8 GB RAM, ~1.6 GB Disk) |
| Deutsch WER | ~4-5% (Hochdeutsch) |
| Geschwindigkeit (M1) | ~0.3-0.5x Echtzeit (60 Min Audio in 18-30 Min) |
| Geschwindigkeit (M3 Pro) | ~0.15-0.3x Echtzeit |
| Word-Timestamps | Ja (`--word-timestamps`) |

## Begründung

- **Keine Python-Dependency:** whisper.cpp ist ein nativer C++-Binary — kein Python-Overhead für ASR, kleineres Bundle.
- **Metal GPU:** Schnellste Variante auf Apple Silicon dank nativer Metal-Beschleunigung.
- **Q5_0-Quantisierung:** Minimaler Qualitätsverlust bei deutlich geringerem RAM-Verbrauch (~1.8 GB statt ~6 GB für das volle Modell).
- **Subprocess-Architektur:** Einfacher und robuster als ein N-API Addon (Entscheidung T2). Prozess kann sauber beendet werden, Crashes isoliert.
- **Schweizerdeutsch:** `language=de` mit `task=transcribe` führt implizite Dialektnormalisierung durch — für leichten bis mittleren Dialekt ausreichend.
- **Alternative verworfen — faster-whisper (Python):** Gute Performance via CTranslate2, aber erfordert Python-Runtime für ASR und bietet keine Metal-Beschleunigung auf macOS.
- **Alternative verworfen — mlx-whisper (Python):** Schnellste Implementation auf Apple Silicon (~0.15-0.3x RTF), aber erfordert Python-Sidecar auch für ASR. Als Plugin-Alternative vorgesehen (NFR-9).

## Konsequenzen

- **Separate Binary:** whisper.cpp muss als vorcompilierter Binary mitgeliefert werden (~5 MB).
- **Modell-Download:** ~1.6 GB beim Erststart.
- **Schweizerdeutsch-Limitation:** Starker Dialekt (Wallis, Graubünden) liefert schlechtere Ergebnisse. Post-MVP: Fine-Tuning auf STT4SG-Daten geplant.
- **Plugin-Architektur:** NFR-9/10 erfordern, dass das ASR-Modell austauschbar bleibt — z.B. gegen mlx-whisper oder ein fine-getuntes Modell.
