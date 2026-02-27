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
