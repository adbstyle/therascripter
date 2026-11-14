export type PlaceholderType =
  | 'PERSON'
  | 'ORT'
  | 'DATUM'
  | 'KONTAKT'
  | 'ORGANISATION'
  | 'MEDIZINISCH'
  | 'SONSTIGES'

export type EntitySource = 'ner' | 'blocklist' | 'manual'

export interface EntityMapEntry {
  original: string
  placeholder: string
  type: PlaceholderType
  source: EntitySource
}

export interface EntityMap {
  [entityId: string]: EntityMapEntry
}

/**
 * Issue #203 — token (`[PERSON 1]`) → original, recorded when a session title
 * or summary was written (see shared/utils/resolvePlaceholders).
 */
export type PlaceholderSnapshot = Record<string, string>
