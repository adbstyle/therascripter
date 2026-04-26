import { Bot, BookOpen, Pencil } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
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

export const SOURCE_LABELS: Record<EntitySource, { icon: LucideIcon; label: string }> = {
  ner: { icon: Bot, label: 'Automatisch erkannt (NER)' },
  blocklist: { icon: BookOpen, label: 'Sperrliste' },
  manual: { icon: Pencil, label: 'Manuell markiert' }
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

export function formatPlaceholderLabel(type: PlaceholderType, number: number): string {
  return `${TYPE_LABELS[type] ?? type} ${number}`
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
