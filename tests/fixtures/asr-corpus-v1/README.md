# ASR Test Corpus v1

Versioniertes Test-Korpus für die Pipeline-Inversion (Issue #78 / ADR-007).

## Struktur

- `manifest.json` — Liste aller Fixtures mit Metadaten
- `audio/` — WAV-Dateien (48 kHz mono PCM 16-bit), gitignored (zu groß / Datenschutz)
- `ground-truth/` — Referenz-Transkripte als JSON (TranscriptData-Format)
- `hallucination-blocklist.txt` — Bekannte Halluzinations-Strings, die im Output NIE auftauchen dürfen

## Wie wird das Korpus bereitgestellt?

Audio-Files liegen außerhalb des Git-Repos (Datenschutz für reale Therapie-Aufnahmen).
Bis zur Bereitstellung der echten Therapie-Aufnahmen (siehe Issue #78, offene Frage 1) werden
synthetische / öffentliche Fixtures verwendet.

## Test-Szenarien (manifest.json)

- `silence-only` — 5 min reine Stille → leerer Output erwartet
- `speech-with-silence-tail` — 30 s Sprache + 10 min Stille → kein Halluzinations-Tail
- `short-speech` — 4 s Sprache → minimaler Output, kein Crash
- `multi-speaker-news` — Spike-A-Audio (öffentlich), Multi-Speaker
- `therapie-realistic-{1..5}` — echte Therapie-Aufnahmen (TBD via offene Frage 1)

## Integration-Test Aktivierung

Der Pipeline-Inversion-Integration-Test überspringt Fixtures, deren Audio-File
nicht vorhanden ist. Vollständig laufen lassen mit:

```bash
THERASCRIPT_RUN_INTEGRATION=1 npx vitest run tests/integration/pipeline-inversion.test.ts
```
