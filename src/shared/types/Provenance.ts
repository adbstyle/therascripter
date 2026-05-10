/**
 * Issue #84 / Story I — Modell-Provenienz pro Sitzung.
 *
 * Snapshot der pro Pipeline-Gruppe aktiven Modelle, captured-at-source bei
 * Pipeline-Start. Wird in der Sessions-Tabelle als JSON-Spalte persistiert
 * und ist für DSGVO Art. 15 (Auskunftsrecht) sowie forensische
 * Reproduzierbarkeit relevant.
 *
 * `label` und `sizeBytes` werden zusätzlich zu den vom Architekten geforderten
 * `{id, sha256, version}` gespeichert, damit ein späterer Katalog-Rename oder
 * eine Neu-Verpackung die Sitzungs-Historie nicht rückwirkend umschreibt.
 */
export interface ModelSnapshot {
  id: string
  label: string
  version: string
  sha256: string
  sizeBytes: number
}

export interface ProcessedModelsSnapshot {
  /** ISO-8601 — wann der Snapshot beim Pipeline-Start geschrieben wurde. */
  capturedAt: string
  /** Spracherkennung (Whisper). null wenn der Step nicht geplant war. */
  asr: ModelSnapshot | null
  /** Sprechererkennung (pyannote). null wenn der Step nicht geplant war. */
  diarization: ModelSnapshot | null
  /** Pseudonymisierung (flair NER). null wenn der Step nicht geplant war. */
  ner: ModelSnapshot | null
  /** Zusammenfassung (LLM). null wenn der Step nicht geplant oder ohne aktives Modell war. */
  summarization: ModelSnapshot | null
}

/**
 * Issue #99 — aggregated audio statistics surfaced in the Provenance panel.
 *
 * Every field is independently nullable: a corrupt diarization JSON or a
 * legacy session without a stitch-map should still render the rows that ARE
 * available, with "nicht verfügbar" for the unknown ones, instead of
 * collapsing the whole section.
 */
export interface AudioStats {
  /** Aus `transcript.metadata.stitchMap.originalDurationSec` (ADR-007); Fallback `transcript.metadata.duration` für Legacy-/Empty-Speech-Sessions. */
  originalDurationSec: number | null
  /** Aus `transcript.metadata.stitchMap.stitchedDurationSec`; bei Empty-Speech (`speakerCount === 0`, kein stitchMap) synthetisch 0. */
  stitchedDurationSec: number | null
  /** Aus `diarization.json` `speakerCount`. */
  speakerCount: number | null
  /** Aus `diarization.json` `metadata.model` (HF-Identifier). */
  diarizationModel: string | null
}
