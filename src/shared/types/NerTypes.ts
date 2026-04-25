import type { EntitySource, PlaceholderType } from './EntityMap'

/** Entity detected by flair NER (from Python sidecar output) */
export interface NerEntity {
  text: string
  type: string // flair type: PER, LOC, ORG, MISC
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
