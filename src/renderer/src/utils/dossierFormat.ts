import { formatSwissDate, localTodayIso } from '../../../shared/utils/calendar-date'
import { normalizeDossierKey } from '../../../shared/utils/dossier-normalize'
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

type NameFields = Pick<DossierRef, 'firstName' | 'lastName'>
type DistinctionFields = NameFields & Pick<DossierRef, 'externalId' | 'birthDate'> & { id?: string }
/** Was eine Übersichtszeile zusätzlich hat: Anlagezeitpunkt und Anzahl Einträge. */
type FallbackFields = DistinctionFields & { id: string; createdAt?: string; entryCount?: number }

/**
 * «angelegt am 05.11.2026 · 3 Einträge» — unterscheidet gleichnamige Dossiers,
 * die weder ID noch Geburtsdatum haben, über etwas, das der USER kennt.
 * Anlagetag in Lokalzeit; leer, wenn der Zeitpunkt fehlt.
 */
export function dossierFallbackDistinction(
  createdAt: string | undefined,
  entryCount?: number
): string {
  if (!createdAt) return ''
  const created = new Date(createdAt)
  if (Number.isNaN(created.getTime())) return ''
  const parts = [`angelegt am ${formatSwissDate(localTodayIso(created))}`]
  if (entryCount !== undefined) {
    parts.push(entryCount === 0 ? 'keine Einträge' : pluralize(entryCount, 'Eintrag', 'Einträge'))
  }
  return parts.join(' · ')
}

/**
 * Mehrfach vergebene Namen (Schlüssel wie `dossierNameKey`) und — für
 * gleichnamige Dossiers ohne ID und Geburtsdatum — ein Ersatz-Zusatz pro
 * Dossier-ID. Ein `Set` der Namen, damit jede Stelle es wie bisher als
 * `ReadonlySet<string>` weiterreichen kann.
 */
export class AmbiguousDossierNames extends Set<string> {
  readonly fallbacks: ReadonlyMap<string, string>
  constructor(keys: Iterable<string> = [], fallbacks: ReadonlyMap<string, string> = new Map()) {
    super(keys)
    this.fallbacks = fallbacks
  }
}

/** Vergleichsschlüssel des angezeigten Namens (gleiche Regel wie die Dublettenprüfung). */
export function dossierNameKey(ref: NameFields): string {
  return `${normalizeDossierKey(ref.lastName)}\u0000${normalizeDossierKey(ref.firstName)}`
}

/**
 * Namen (Schlüssel), die mehr als ein Dossier trägt. Tragen die Einträge
 * ID, Anlagezeitpunkt und Anzahl (Übersichtszeilen), kommt für gleichnamige
 * ohne ID und Geburtsdatum der Ersatz-Zusatz dazu.
 */
export function ambiguousDossierNames(
  list: readonly (NameFields | FallbackFields)[]
): AmbiguousDossierNames {
  const seen = new Set<string>()
  const keys = new Set<string>()
  for (const ref of list) {
    const key = dossierNameKey(ref)
    if (seen.has(key)) keys.add(key)
    else seen.add(key)
  }
  const fallbacks = new Map<string, string>()
  for (const ref of list) {
    if (!keys.has(dossierNameKey(ref)) || !('id' in ref) || !('createdAt' in ref)) continue
    if (ref.externalId || ref.birthDate) continue
    const fallback = dossierFallbackDistinction(ref.createdAt, ref.entryCount)
    if (fallback) fallbacks.set(ref.id, fallback)
  }
  return new AmbiguousDossierNames(keys, fallbacks)
}

/**
 * Zusatz für gleichnamige Dossiers (Sichtprüfung): gibt es mehrere Dossiers
 * mit diesem Namen, die Dossier-ID, sonst das Geburtsdatum, sonst «angelegt
 * am … · N Einträge» (wenn `ambiguous` ihn kennt, siehe
 * `ambiguousDossierNames`); bei eindeutigem Namen kein Zusatz ('').
 */
export function dossierDistinction(ref: DistinctionFields, ambiguous: ReadonlySet<string>): string {
  if (!ambiguous.has(dossierNameKey(ref))) return ''
  if (ref.externalId) return ref.externalId
  if (ref.birthDate) return formatSwissDate(ref.birthDate)
  if (ref.id && ambiguous instanceof AmbiguousDossierNames) {
    return ambiguous.fallbacks.get(ref.id) ?? ''
  }
  return ''
}

/** «Hofer, Lukas» bzw. bei gleichnamigen Dossiers «Hofer, Lukas (P-1001)». */
export function dossierLabel(ref: DistinctionFields, ambiguous: ReadonlySet<string>): string {
  const distinction = dossierDistinction(ref, ambiguous)
  return distinction ? `${dossierListName(ref)} (${distinction})` : dossierListName(ref)
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

/**
 * Vollständiger Zusatz für gleichnamige Dossiers in Dialogen: «ID ·
 * Geburtsdatum», soweit vorhanden, sonst «angelegt am … · N Einträge»; bei
 * eindeutigem Namen ''. `fallback` ersetzt den Eintrag aus `ambiguous`, wenn
 * der Aufrufer Anlagezeitpunkt und Anzahl selbst kennt.
 */
export function dossierFullDistinction(
  ref: DistinctionFields,
  ambiguous: ReadonlySet<string>,
  fallback?: { createdAt?: string; entryCount?: number }
): string {
  if (!ambiguous.has(dossierNameKey(ref))) return ''
  const identification = dossierIdentification(ref)
  if (identification) return identification
  if (fallback?.createdAt)
    return dossierFallbackDistinction(fallback.createdAt, fallback.entryCount)
  if (ref.id && ambiguous instanceof AmbiguousDossierNames) {
    return ambiguous.fallbacks.get(ref.id) ?? ''
  }
  return ''
}
