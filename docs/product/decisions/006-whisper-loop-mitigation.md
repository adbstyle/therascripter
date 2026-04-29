# ADR-006: Whisper-Loop-Mitigation durch `--no-context` und Output-Detection

**Status:** Superseded by [ADR-007](./007-pipeline-inversion.md)
**Datum:** 2026-04-27
**Implementiert:** 2026-04-27 (#65, branch `fix/65-whisper-loop-mitigation`)
**Revidiert:** 2026-04-28 — Hard-Reject + manueller Retry verworfen, Pipeline läuft jetzt immer durch und zeigt nur eine nicht-blockierende Quality-Warning (Folge-PR `fix/68-quality-warning-no-rejection`).
**Revidiert:** 2026-04-28 — CLI-Flag von `-nc` auf `-mc 0` korrigiert. Das ursprünglich dokumentierte `--no-context` / `-nc` wurde von whisper.cpp upstream entfernt; aktuelle Versionen erkennen es nicht mehr und exit'en mit `error: unknown argument: -nc` (aber Exit Code 0 — siehe Folge-PR).
**Superseded:** 2026-04-29 — Pipeline-Inversion (ADR-007 / Issue #78) löst das Problem strukturell: Whisper sieht nach der Inversion gar keine Stille mehr (nur Pyannote-Speech-Segmente) und kann darauf keine Halluzinationen mehr produzieren. Layered-Detector (`whisper-quality.ts`, `QualityWarningBanner`, `quality_flag`-Spalte) entfernt; `-mc 0` bleibt als Defense-in-Depth.

> **2026-04-29 — Hinweis:** Diese Entscheidung wurde durch ADR-007 (Pipeline-Inversion) abgelöst.
> `-mc 0` bleibt als Defense-in-Depth aktiv, der Output-Detector (`computeRepetitionRatio`,
> `quality_flag`-Spalte, `QualityWarningBanner`) wurde entfernt — die strukturelle
> Lösung der Inversion macht ihn überflüssig.

## Kontext

Eine Userin hat gemeldet, dass bei langen Therapieaufnahmen der zuletzt gesprochene Satz im finalen Transkript 100+ mal wiederholt wird. Die Untersuchung (Datei: [src/main/ml/WhisperService.ts:115-126](src/main/ml/WhisperService.ts#L115-L126)) ergab, dass `whisper-cli` aktuell **ohne ein einziges Anti-Halluzinations-Flag** aufgerufen wird:

```
nice -n 10 whisper-cli -m <model> -f <audio> -l de -pp -ojf -t <threads>
```

whisper.cpp arbeitet intern in 30-Sekunden-Fenstern und konditioniert per Default jedes Fenster auf den Output des vorherigen (`condition_on_previous_text=true`). Bei langen Aufnahmen mit Stille (Pausen in der Therapie, leiser Aufnahme-Auslauf) kann das Modell in einem Fenster halluzinieren — die Halluzination landet als Prompt-Kontext im nächsten Fenster, wird damit wahrscheinlicher reproduziert und vergiftet rekursiv jedes weitere Fenster bis Audio-Ende. Das Symptom ("letzter Satz hunderte Male") ist die kanonische Manifestation dieses Failure-Modes (whisper.cpp #612, #689, #1490, #1507, #1724, #2445).

Verstärkende Faktoren in unserem Setup:

- Q5_0-Quantisierung von Large-V3-Turbo ist statistisch loop-anfälliger als F16
- Greedy decoding (kein `--beam-size` gesetzt) macht eingerastete Loops klebrig
- Die komplette WAV (bis zu 2h Auto-Stop) wird in **einem** whisper-cli-Aufruf verarbeitet — kein App-seitiges Splitting, kein VAD
- In [`processOutput()`](src/main/ml/WhisperService.ts#L234-L260) gibt es **keine** Output-side Validierung — fehlerhafte Transkripte werden ungeprüft persistiert und kaskadieren durch Diarization-Alignment, NER und Summarization

Die Halluzination ist die gefährlichste Klasse von Bug für ein medizinisches Tool: Das Transkript sieht plausibel aus, ist inhaltlich aber falsch. Therapeutinnen können den Schaden nur erkennen, wenn sie das Audio gegen das Transkript abgleichen — was die Anonymisierungs-Pipeline gerade ersparen soll.

## Entscheidung

Defense-in-Depth-Mitigation auf zwei Ebenen, in einem PR ausgeliefert:

**Ebene 1 — CLI-Flag:** `whisper-cli` wird mit `-mc 0` (`--max-context 0`) aufgerufen. Damit wird die Anzahl der Kontext-Token zwischen 30-Sekunden-Fenstern auf null gesetzt — semantisch identisch zum (in modernen whisper.cpp-Versionen entfernten) `--no-context`-Flag. Self-Reinforcing-Loops können sich nicht mehr über Fenster-Grenzen hinweg fortpflanzen.

**Ebene 2 — Output-Validierung (nicht-blockierend):** [`WhisperService`](src/main/ml/WhisperService.ts) berechnet eine Repetition-Ratio über die generierten Segmente. Ab definierten Schwellwerten wird ein `quality_flag` auf der Session persistiert und im Review-Editor als Warnungs-Banner angezeigt. Die Pipeline läuft in jedem Fall **vollständig durch** (Diarization → Anonymization → Summarization), damit der User das Resultat sehen, prüfen und ggf. als Bug melden kann. Ein deterministischer „Retry auf gleichem Modell" hätte keinen Mehrwert und wurde explizit nicht implementiert.

| Flag / Mechanismus | Wert | Wirkung |
|--------------------|------|---------|
| `-mc 0` / `--max-context 0` | gesetzt | Setzt die Anzahl Kontext-Token zwischen 30-s-Fenstern auf null |
| Repetition-Ratio (Output-Detection) | `> 0.3` → `repetition_warning` (gelber Banner), `> 0.7` → `repetition_critical` (roter Banner) | Detektiert Loops post-hoc; nicht-blockierend, Pipeline läuft komplett durch |

Explizites Setzen der whisper.cpp-Defaults (`--temperature`, `--entropy-thold`, etc.) wird **nicht** vorgenommen — das würde uns an heutige Defaults binden und zukünftige Upstream-Verbesserungen blockieren.

VAD (`--vad`) wird **nicht** in dieser Iteration aktiviert. VAD trimmt Stille; in Therapie-Sitzungen ist Schweigen aber semantisch bedeutsam und VAD-getrimmte Timestamps können das Speaker-Alignment ([`pyannote-Diarization`](docs/product/decisions/003-pyannote-diarization.md)) und die Audio-Playback-Synchronisation im Review-Editor brechen. Eine Evaluation bleibt offen für ADR-007.

## Begründung

- **Max-Context-Null ist der Community-Standard.** Dokumentiert in mehreren whisper.cpp-Issues als primäre Mitigation für Long-Audio-Loops. Funktional identisch zum alten `--no-context`-Flag, aber stabil im aktuellen API.
- **Trade-off ist akzeptabel.** Whisper kann Wörter, die exakt auf einer 30-s-Window-Grenze abgeschnitten sind, ohne Kontext schlechter rekonstruieren. Bei Therapie-Transkripten ist diese minimale Coherence-Einbusse irrelevant — die nachgelagerte Diarization, NER und manuelle Review fangen den Unterschied auf.
- **Output-Detection statt nur CLI-Fix.** Eine ML-Pipeline, deren Loop-Schutz an einem einzigen CLI-Flag hängt, ist eine Single-Point-of-Failure-Architektur. Ein zukünftiges whisper.cpp-Upgrade, ein Modell-Swap (NFR-9) oder ein Custom-User-Modell könnte das Verhalten ändern. Output-Validierung kostet ~50 LOC, ist modell-agnostisch und schützt zusätzlich vor anderen Failure-Modes (z.B. extreme NER-Fehler im Anonymisierungs-Step).
- **Recovery für historische Sessions.** Stufe 2 ermöglicht ein Backfill-Script, das bestehende `~/.therascript/data/transcripts/`-Dateien scannt und vergiftete Sessions flaggt — wichtig, da der Bug seit Pipeline-Einführung undetected in Produktion lief.
- **Observability.** Repetition-Ratio wird geloggt. Das ist die billigste Form von Production-Telemetry für ein bisher untelemetrisches ML-Feature.
- **Alternative verworfen — VAD:** siehe Kontext oben. Pipeline-Risiko gegenüber Word-Timestamps, separat zu evaluieren.
- **Alternative verworfen — App-seitiges Audio-Chunking mit ffmpeg:** Erhöhte Komplexität (Chunk-Grenzen, Speaker-Continuity über Chunks, Re-Assembly), `-nc` löst das Problem auf der besseren Architekturebene.
- **Alternative verworfen — Wechsel auf F16-Modell:** ~3.5x RAM, sprengt das 8 GB-Budget (NFR), behebt das eigentliche Konditionierungs-Problem nicht.

## Konsequenzen

- **Geringfügig schwächere Token-Coherence über Window-Grenzen.** Praktisch nicht messbar in Therapie-Transkripten.
- **Repetition-Detection kann False-Positives erzeugen** bei legitimen Wiederholungen (Mantra-artige Phrasen in CBT, "Ja, ja, ja"-Reflektionen). Schwellwerte müssen empirisch getunt werden — Initial-Wert konservativ (0.3 / 0.7), Follow-up-Tuning anhand realer Sessions.
- **Migration-Pfad nötig.** Bestehende Sessions auf Repetition-Ratio scannen; Userinnen müssen über betroffene Sessions informiert und ein Re-Run-Pfad angeboten werden (eigenes Issue, nicht Scope dieses ADR).
- **Regression-Test-Asset offen.** Ein scriptbares langes WAV mit Trailing-Silence in `tests/fixtures/` wäre wünschenswert, um End-to-End zu verifizieren, dass `qualityFlag` korrekt persistiert wird. Da die Pipeline in der revidierten Variante nie hart abbricht, ist die Coverage-Lücke nicht mehr Pipeline-blockierend — bleibt offen für ADR-007 oder einen gezielten Folge-PR.
- **Plugin-Architektur (NFR-9/10) bleibt unberührt.** `-mc 0` ist ein generischer whisper.cpp-Flag; die Output-Detection ist modell-agnostisch und gilt auch für zukünftige ASR-Plugins (mlx-whisper etc.).
- **Telemetry-Datenpunkt.** Logging der Repetition-Ratio pro Session schafft eine Baseline für zukünftige ASR-Modell-Vergleiche (NFR-9).
- **Kein eigener Retry-Mechanismus für quality-flagged Sessions.** Wir hatten in der ersten Implementierung einen separaten `transcription_quality_failed`-Status mit gated Retry-Button vorgesehen. Verworfen, weil:
  1. Auf gleicher Pipeline-Version ist der Retry deterministisch — gleiche Eingabe, gleicher Loop, gleiches Resultat. Zero Mehrwert.
  2. Wenn wir die Pipeline später verbessern (z.B. Model-Swap), reicht die existierende `error`-Retry-Logik aus, weil der User die Session bei Bedarf manuell neu aufnehmen kann.
  3. Die nicht-blockierende Variante ist einfacher zu erklären und zu warten — ein Banner statt eines Sub-State-Machine-Astes.
  Migration `010-drop-pipeline-version` entfernt die deprecated Spalte und migriert vorhandene `transcription_quality_failed`-Sessions in den `error`-Status.

## Referenzen

- [whisper.cpp Discussion #689 — Long recordings (~1h) not working correctly](https://github.com/ggml-org/whisper.cpp/discussions/689)
- [whisper.cpp Discussion #1490 — Large Model hallucination & repeating](https://github.com/ggml-org/whisper.cpp/discussions/1490)
- [whisper.cpp PR #1768 — Fix the decoding issues](https://github.com/ggml-org/whisper.cpp/pull/1768)
- [whisper.cpp Issue #2445 — Hallucinations and repeats](https://github.com/ggml-org/whisper.cpp/issues/2445)
- [openai/whisper Discussion #679 — A possible solution to hallucination](https://github.com/openai/whisper/discussions/679)
- [ADR-002: whisper.cpp für Spracherkennung](002-whisper-cpp-asr.md)
