import type { EntitySource, PlaceholderType } from './EntityMap'

/**
 * Identifier of the active NER backend implementation. Each backend produces
 * its own native entity-type strings; the TS-side `entity-merger.ts` dispatches
 * on this discriminator to choose the right canonical mapping.
 */
export type NerBackend = 'flair' | 'gliner' | 'ai4privacy'

/** Entity detected by NER (from Python sidecar output). The native `type` string
 * is backend-specific; see `entity-merger.ts` for the per-backend mapping. */
export interface NerEntity {
  text: string
  type: string
  segmentIndex: number
  charStart: number
  charEnd: number
  confidence: number
}

/** Entity detected by regex engine */
export interface RegexEntity {
  text: string
  regexType: string // TELEFON, EMAIL, AHV, PLZ_ORT, GEBURTSDATUM, VERSICHERUNG
  segmentIndex: number
  charStart: number
  charEnd: number
}

/** Entity after merging NER + Regex + Blocklist, before coreference resolution */
export interface MergedEntity {
  text: string
  type: PlaceholderType
  source: EntitySource
  segmentIndex: number
  charStart: number
  charEnd: number
  /** Canonical name for coreference grouping (set by resolver) */
  canonicalText?: string
}

/** NER sidecar output JSON format */
export interface NerServiceOutput {
  entities: NerEntity[]
  metadata: {
    /** Backend identifier — drives canonical-type mapping in `entity-merger.ts`. */
    backend: NerBackend
    /** HuggingFace identifier of the loaded model (e.g. `flair/ner-german-large`). */
    model: string
    segmentCount: number
    entityCount: number
  }
}

/** Blocklist entry as stored in SQLite */
export interface BlocklistEntry {
  id: string
  term: string
  placeholderType: PlaceholderType
  createdAt: string
}
