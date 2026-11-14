import { formatSwissDate, localTodayIso } from '../../../shared/utils/calendar-date'
import type { DossierRef } from '../../../shared/types/Dossier'

/** «Nachname, Vorname» — Übersicht, Hinweise, Plaketten. */
export function dossierListName(ref: Pick<DossierRef, 'firstName' | 'lastName'>): string {
  return `${ref.lastName}, ${ref.firstName}`
}

/** «Vorname Nachname» — Seitenkopf und Dialogtitel. */
export function dossierDisplayName(ref: Pick<DossierRef, 'firstName' | 'lastName'>): string {
  return `${ref.firstName} ${ref.lastName}`
}

/** «PD-1188 · 03.02.1978» zur Unterscheidung gleichnamiger Dossiers; leer ohne beides. */
export function dossierIdentification(ref: Pick<DossierRef, 'externalId' | 'birthDate'>): string {
  return [ref.externalId, ref.birthDate ? formatSwissDate(ref.birthDate) : null]
    .filter(Boolean)
    .join(' · ')
}

export function pluralize(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/** «Keine Einträge», «1 Eintrag», «9 Einträge». */
export function entryCountLabel(count: number): string {
  return count === 0 ? 'Keine Einträge' : pluralize(count, 'Eintrag', 'Einträge')
}

function shiftIsoDay(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  return localTodayIso(new Date(y, m - 1, d + days))
}

/**
 * Tag des jüngsten Eintrags: «Heute», «Gestern», «05.11.» im laufenden Jahr,
 * sonst «05.11.2025»; ohne Einträge «—». `day` und `todayIso` sind lokale
 * ISO-Tage (der Main-Prozess rechnet `lastEntryDay` schon in Lokalzeit).
 */
export function lastEntryLabel(day: string | null, todayIso: string = localTodayIso()): string {
  if (!day) return '—'
  if (day === todayIso) return 'Heute'
  if (day === shiftIsoDay(todayIso, -1)) return 'Gestern'
  const swiss = formatSwissDate(day)
  return day.slice(0, 4) === todayIso.slice(0, 4) ? swiss.slice(0, 6) : swiss
}

/**
 * «Es gibt bereits ein Patientendossier mit diesem Namen (PD-0412 · 11.06.1969).»
 * Die Klammer unterscheidet gleichnamige Dossiers über ID und Geburtsdatum
 * und entfällt, wenn keines davon etwas trägt.
 */
export function duplicateNameText(duplicates: DossierRef[]): string {
  const what =
    duplicates.length === 1 ? 'ein Patientendossier' : `${duplicates.length} Patientendossiers`
  const ids = duplicates.map(dossierIdentification).filter(Boolean)
  return `Es gibt bereits ${what} mit diesem Namen${ids.length > 0 ? ` (${ids.join('; ')})` : ''}.`
}
