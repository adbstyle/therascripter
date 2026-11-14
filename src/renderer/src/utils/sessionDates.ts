import { startOfDay } from '../hooks/useStartOfToday'
import {
  formatSwissDate,
  isValidIsoDateNotAfter,
  localTodayIso,
  parseSwissDate
} from '../../../shared/utils/calendar-date'
import type { Session } from '../../../shared/types'

// Modulweit gecacht: toLocale*String mit Optionen baut pro Aufruf einen neuen
// Intl-Formatter (~33 µs), bei vielen Karten pro Render spürbar.
const TIME_FORMAT = new Intl.DateTimeFormat('de-CH', { hour: '2-digit', minute: '2-digit' })
const DAY_MONTH_FORMAT = new Intl.DateTimeFormat('de-CH', { day: '2-digit', month: '2-digit' })
const SHORT_DATE_FORMAT = new Intl.DateTimeFormat('de-CH', {
  day: '2-digit',
  month: '2-digit',
  year: '2-digit'
})
export const FULL_TIMESTAMP_FORMAT = new Intl.DateTimeFormat('de-CH', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit'
})

/** «14:00», «Gestern, 14:00», «06.11., 14:00», in früheren Jahren «06.11.25». */
export function formatCardTimestamp(iso: string, today: number): string {
  const date = new Date(iso)
  const time = TIME_FORMAT.format(date)

  const dayDiff = Math.round((today - startOfDay(date)) / 86_400_000)

  if (dayDiff === 0) return time
  if (dayDiff === 1) return `Gestern, ${time}`

  if (date.getFullYear() === new Date(today).getFullYear()) {
    return `${DAY_MONTH_FORMAT.format(date)}, ${time}`
  }

  return SHORT_DATE_FORMAT.format(date)
}

/** Importdatum eines PDFs: der lokale Tag seines Imports (`YYYY-MM-DD`). */
export function importDayIso(createdAt: string): string {
  return localTodayIso(new Date(createdAt))
}

export interface DocumentDateInfo {
  /** Geltendes Datum als `TT.MM.JJJJ`. */
  date: string
  /** true: der USER hat es festgelegt; false: es gilt das Importdatum (#205 AK 19/20). */
  isSet: boolean
  /** Importdatum als `TT.MM.JJJJ`. */
  importDate: string
}

/** Geltendes Dokumentdatum eines PDFs und woher es kommt. */
export function documentDateInfo(
  session: Pick<Session, 'createdAt' | 'documentDate'>
): DocumentDateInfo {
  const importDate = formatSwissDate(importDayIso(session.createdAt))
  const set = session.documentDate ?? null
  return { date: set ? formatSwissDate(set) : importDate, isSet: set !== null, importDate }
}

/** «02.11.2026» bzw. «08.11.2026 · Importdatum» (#205 AK 20). */
export function documentDateLabel(session: Pick<Session, 'createdAt' | 'documentDate'>): string {
  const info = documentDateInfo(session)
  return info.isSet ? info.date : `${info.date} · Importdatum`
}

/** Prüft die Eingabe (#205 AK 21); Meldung oder ISO-Tag. */
export function validateDocumentDate(
  input: string,
  todayIso: string = localTodayIso()
): { iso: string } | { error: string } {
  if (input.trim().length === 0) return { error: 'Bitte geben Sie ein Datum ein.' }
  const iso = parseSwissDate(input)
  if (!iso) {
    return { error: 'Bitte ein vollständiges, gültiges Datum im Format TT.MM.JJJJ angeben.' }
  }
  if (!isValidIsoDateNotAfter(iso, todayIso)) {
    return { error: 'Das Dokumentdatum darf nicht nach dem heutigen Tag liegen.' }
  }
  return { iso }
}
