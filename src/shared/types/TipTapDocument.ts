import type { EntitySource, PlaceholderType } from './EntityMap'

export interface TipTapDocument {
  type: 'doc'
  content: TipTapParagraph[]
}

export interface TipTapParagraph {
  type: 'paragraph'
  content: TipTapInlineNode[]
}

export type TipTapInlineNode =
  | TipTapTextNode
  | TipTapPlaceholderChip
  | TipTapSpeakerLabel
  | TipTapTimestamp

export interface TipTapTextNode {
  type: 'text'
  text: string
}

export interface TipTapPlaceholderChipAttrs {
  entityId: string
  type: PlaceholderType
  number: number
  source: EntitySource
  original: string
}

export interface TipTapPlaceholderChip {
  type: 'placeholderChip'
  attrs: TipTapPlaceholderChipAttrs
}

export interface TipTapSpeakerLabelAttrs {
  speaker: string // "A", "B", "C", etc.
  label: string // "Person A", "Person B", etc.
}

export interface TipTapSpeakerLabel {
  type: 'speakerLabel'
  attrs: TipTapSpeakerLabelAttrs
}

export interface TipTapTimestampAttrs {
  seconds: number
  formatted: string // "HH:MM:SS"
}

export interface TipTapTimestamp {
  type: 'timestamp'
  attrs: TipTapTimestampAttrs
}
