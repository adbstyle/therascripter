# ADR-007: Pipeline-Inversion — Diarization-First, Speech-Only ASR

**Status:** Accepted
**Datum:** 2026-04-29
**Implementiert:** 2026-04-29 (Issue #78)
**Supersedes:** ADR-006 (Whisper-Loop-Mitigation)

## Kontext

Whisper produziert auf reinen Stille- oder Geräusch-Segmenten statistisch wahrscheinliche Trainings-Phrasen ("Vertraue und glaube, es hilft, es heilt die göttliche Kraft!", "Untertitelung des ZDF, 2020"). ADR-006 versuchte, das per Inter-Window-Loop-Prevention (`-mc 0`) und Output-Detector (`computeRepetitionRatio`) zu adressieren. Live-Test 28.04.2026 (12:43 min Therapie-Audio + 50 min Stille) zeigte: `-mc 0` schließt Inter-Window-Loops, **aber nicht In-Window-Halluzinationen auf Stille**. Pro Stille-Window produziert Whisper unabhängig dieselbe Phrase — der Detector erkennt das, der User sieht trotzdem Garbage im Transkript.

Drei Spikes (A: Quality-Erhalt der Inversion, B: Pyannote-Silence-Precision, C: Whisper-Aufruf-Strategie) wurden vor diesem ADR durchgeführt — Resultate siehe Issue #78 Section 3.

## Entscheidung

Die Audio-Pipeline wird invertiert:

**Vorher (ADR-006-Welt):**
1. Whisper transkribiert die volle WAV (incl. Stille → Halluzinationen)
2. Pyannote Diarization
3. Alignment
4. Anonymisierung
5. (optional) Summarization

**Nachher (ADR-007):**
1. Pyannote Diarization → Speech-Segment-Liste
2. ffmpeg-Stitch der Speech-Segmente mit ±200 ms Padding zu einer kontinuierlichen WAV (`AudioStitchService`)
3. Whisper-cli Aufruf auf der gestitchten WAV (single subprocess call)
4. Output-Timestamps via persistierter `StitchMap` zurück auf Original-Wall-Clock gemappt
5. Alignment, Anonymisierung, (optional) Summarization wie bisher

**Begründung:**

- *Correct by construction:* Whisper bekommt keine Stille mehr zu sehen, kann also strukturell keine Stille-Halluzinationen mehr produzieren.
- *Performance besser, nicht schlechter:* Spike C zeigt **0.34× Baseline** auf Test-Audio — Whisper hat ~80 % weniger Material zu prozessieren. NFR-2 (≤ 1.20×) deutlich unterboten.
- *Plugin-Architektur (NFR-9) bleibt intakt:* Der Vertrag zwischen Diarization-Output und ASR-Input wird in dieser ADR formal dokumentiert (siehe "Schnittstelle"), beide Schichten sind unabhängig austauschbar.
- *Defense in Depth:* `-mc 0` bleibt als Whisper-Flag erhalten — kostenlose zusätzliche Sicherheit gegen Inter-Window-Loops in den verbleibenden Speech-Segmenten.

## Schnittstelle (Plugin-Vertrag, NFR-9)

**Diarization → ASR-Stitching:**

```typescript
interface DiarizationData {
  speakers: SpeakerSegment[] // [{ label, start, end }, ...]
  speakerCount: number
  metadata: { model: string; duration: number }
}
```

**ASR-Output → Alignment:**

Ein `TranscriptData` mit Word- und Segment-Timestamps **in Original-Audio-Timeline** (Stitch-Map-Remap erfolgt im ASR-Service). `metadata.stitchMap` ist optional persistiert für Debugging.

**Padding-Strategie:**
- ±200 ms symmetrisch um jedes Speech-Segment
- An Audio-Boundaries (0 und originalDuration) clampen
- Überlappende padded Segmente werden gemerged (Stille zwischen ihnen ist kürzer als das kombinierte Padding → Stitching ohne Naht)

## NFR-2 Performance-Baseline

- **Build-SHA-Baseline:** TBD (festzulegen vor Story-3-Merge)
- **Hardware-Baseline:** Apple M5 Pro, 64 GB RAM, macOS 14
- **Mess-Methodik:** p95 über 5+ Runs auf Spike-Test-Audio (62:43 min)
- **Aktueller Wert:** 0.34× Baseline (siehe Spike C)

## Konsequenzen

**Positiv:**
- Strukturell statt heuristisch → keine wachsende Phrase-Blocklist
- Performance besser (Whisper auf weniger Audio)
- Layered-Detector-Stack kann entfernt werden (`whisper-quality.ts`, Banner, `quality_flag`-Spalte)
- `-mc 0` bleibt als Defense-in-Depth

**Negativ / Risiken:**
- Backchannel-Recall auf realem Therapie-Audio empirisch nicht belegt — Verifikation gegen 3–5 echte Aufnahmen war Story-3-Merge-Bedingung (siehe Issue #78)
- ffmpeg-Binary muss gebundled werden (statisches ARM64-Binary von osxexperts.net; evermeet.cx bietet primär x86_64 — auf Apple Silicon nur via Rosetta 2, was den Performance-Gewinn der Inversion zunichtemacht)
- Stitching-Naht-Robustheit auf Audio mit häufigen Speaker-Turns ist empirisch nur auf News-Audio belegt; Therapie-Audio mit kürzeren Turn-Längen war Verifikations-Voraussetzung

**Operativ:**
- Migration 011 setzt alle in-flight Sessions auf `error`-Status (silent failure mode laut Issue Out-of-Scope #3 — kein User-Hinweis)
- Bestehende `review`-Sessions bleiben unangetastet
- Plugin-Architektur (NFR-9): Diarization- und ASR-Backends bleiben austauschbar

## Bekannte Limits / Follow-up

1. **`runFfmpeg` AbortSignal:** Implementierung respektiert `AbortSignal` (kill SIGTERM bei Abort). Praxis-Risiko bei Stitching-Stalls auf PCM-WAV: minimal.
2. **ARG_MAX bei vielen Speech-Segmenten:** Pro merged Segment ein `-ss/-to/-i`-Triplet (≈ 60–80 Bytes). macOS-`ARG_MAX` liegt bei ~1 MB → praktisches Limit ist **~12 000 Segmente**. Realistisches Therapie-Audio (1 h) produziert nach Pyannote-Merge typischerweise 200–500 Segmente, also ~30 KB Argv — weit unter dem Limit. Falls in Zukunft hochgradig fragmentiertes Audio (z. B. mehrstündige Multi-Speaker-Workshops) das Limit doch erreicht: Fix-Pfad ist eine Concat-Demuxer-Listen-Datei (`ffmpeg -f concat -i list.txt`).

## Referenzen

- Issue: [adbstyle/therascripter#78](https://github.com/adbstyle/therascripter/issues/78)
- Spike-Resultate: Issue #78 Section 3
- Verworfene Alternativen: Issue #78 Section 11 (Phrase-Blocklist, `--vad`-Flag, Super-Chunks, whisper-server)
- Vorgänger: ADR-006 (Whisper-Loop-Mitigation, jetzt superseded)
