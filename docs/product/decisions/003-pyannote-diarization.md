# ADR-003: pyannote.audio für Speaker Diarization

**Status:** Accepted
**Datum:** 2025-02

## Kontext

Therapiesitzungen haben typischerweise 2-4 Sprecher (Therapeut + Patienten). Die Transkription muss jedem Textabschnitt den richtigen Sprecher zuordnen (Speaker Diarization). Das Modell muss auf Deutsch gut funktionieren, lokal auf Apple Silicon laufen und mit dem sequenziellen Pipeline-Design kompatibel sein (ein Modell gleichzeitig).

## Entscheidung

pyannote.audio mit dem Community-Modell `pyannote/speaker-diarization-community-1` wird als Python-Sidecar ausgeführt. Das Alignment mit den ASR-Ergebnissen erfolgt über Word-Timestamps (Midpoint-Algorithmus).

| Eigenschaft | Wert |
|-------------|------|
| Modell | pyannote/speaker-diarization-community-1 |
| Pipeline | Powerset Segmentation, WeSpeaker Embeddings, VBx Clustering |
| DER (Deutsch) | **8.3%** (bester Wert aller evaluierten Modelle) |
| DER (gesamt) | ~11-13% |
| Sprecher-Erkennung | Automatisch, mit `min_speakers`/`max_speakers` Parametern |
| Apple Silicon | CPU (~2-4x Echtzeit), MPS experimentell |
| Lizenz | CC-BY-4.0 (kommerziell nutzbar mit Attribution) |

## Begründung

- **Bester DER auf Deutsch:** 8.3% DER ist der beste Wert aller evaluierten Modelle — entscheidend für deutsche Therapiesitzungen.
- **Exclusive Mode:** Zu jedem Zeitpunkt nur ein aktiver Sprecher — passt zum Therapie-Setting (Gespräch, kein Gruppendiskurs).
- **Automatische Sprecher-Erkennung:** Anzahl Sprecher muss nicht vorab angegeben werden.
- **Community-Modell:** CC-BY-4.0 erlaubt kommerzielle Nutzung (mit Attribution). Kein HuggingFace Pro-Abo nötig.
- **Alternative verworfen — NeMo (NVIDIA):** DER 13.3-13.5% auf Deutsch — deutlich schlechter als pyannote. Grösseres Modell.
- **Alternative verworfen — Senko:** CoreML-nativ, extrem schnell (465x Echtzeit auf M3), aber DER 13.3-13.5%. Als Plugin-Alternative für Speed-Priorisierung vorgesehen.

## Konsequenzen

- **Python-Sidecar erforderlich:** pyannote.audio benötigt eine Python-Runtime mit PyTorch (~500 MB). Der Sidecar wird auch für flair NER genutzt.
- **HuggingFace-Token:** Nutzer (Entwickler) muss HuggingFace-Nutzungsbedingungen für `pyannote/speaker-diarization-3.1` und `pyannote/speaker-diarization-community-1` akzeptieren.
- **Verarbeitungszeit:** ~6-15 Minuten für 60 Minuten Audio auf M3 8 GB (CPU-Modus).
- **RAM:** ~2.0 GB während Diarization (Electron + pyannote).
- **Alignment-Logik:** Midpoint-basiertes Alignment der Word-Timestamps auf Speaker-Segmente. Bei 1 Sprecher werden keine Labels angezeigt, bei 2-4 Sprechern Labels [Person A]-[Person D].
- **Plugin-Architektur:** Modell muss austauschbar bleiben (NFR-9) — z.B. gegen Senko für schnellere Verarbeitung.
