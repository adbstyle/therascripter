import type { PlaceholderType, EntitySource } from '../../../shared/types'

export const CHIP_STYLES: Record<PlaceholderType, string> = {
  PERSON: 'bg-chip-person-bg text-chip-person-text',
  ORT: 'bg-chip-ort-bg text-chip-ort-text',
  DATUM: 'bg-chip-datum-bg text-chip-datum-text',
  KONTAKT: 'bg-chip-kontakt-bg text-chip-kontakt-text',
  ORGANISATION: 'bg-chip-organisation-bg text-chip-organisation-text',
  MEDIZINISCH: 'bg-chip-medizinisch-bg text-chip-medizinisch-text',
  SONSTIGES: 'bg-chip-sonstiges-bg text-chip-sonstiges-text'
}

export const SOURCE_LABELS: Record<EntitySource, { icon: string; label: string }> = {
  ner: { icon: '\uD83E\uDD16', label: 'Automatisch erkannt (NER)' },
  blocklist: { icon: '\uD83D\uDCD6', label: 'Sperrliste' },
  manual: { icon: '\u270F\uFE0F', label: 'Manuell markiert' }
}

export const TYPE_LABELS: Record<PlaceholderType, string> = {
  PERSON: 'Person',
  ORT: 'Ort',
  DATUM: 'Datum',
  KONTAKT: 'Kontakt',
  ORGANISATION: 'Organisation',
  MEDIZINISCH: 'Medizinisch',
  SONSTIGES: 'Sonstiges'
}

export const PLACEHOLDER_TYPE_ORDER: PlaceholderType[] = [
  'PERSON',
  'ORT',
  'DATUM',
  'KONTAKT',
  'ORGANISATION',
  'MEDIZINISCH',
  'SONSTIGES'
]
