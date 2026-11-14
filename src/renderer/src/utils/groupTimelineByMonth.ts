import type { TimelineEntry } from '../../../shared/types/Dossier'

export interface TimelineMonth {
  /** `YYYY-MM` */
  key: string
  /** «November 2026» */
  label: string
  entries: TimelineEntry[]
}

// Zeitzone fest auf UTC: `sortDay` ist ein Kalendertag ohne Uhrzeit. Mit der lokalen Zone
// hinge die Beschriftung davon ab, welche Zone beim Laden des Moduls galt.
const MONTH_FORMAT = new Intl.DateTimeFormat('de-CH', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC'
})

/**
 * Gliedert den Verlauf nach Monaten (#205). Grundlage ist allein `sortDay` aus
 * dem Main-Prozess (lokaler Tag, dort schon sortiert) — der Renderer rechnet
 * keine Zeitzonen um und ändert die Reihenfolge nicht.
 */
export function groupTimelineByMonth(entries: readonly TimelineEntry[]): TimelineMonth[] {
  const months: TimelineMonth[] = []
  let current: TimelineMonth | null = null
  for (const entry of entries) {
    const key = entry.sortDay.slice(0, 7)
    if (!current || current.key !== key) {
      const [year, month] = key.split('-').map(Number)
      // setUTCFullYear statt Date.UTC(y, m, d): dort gelten 0–99 als 1900–1999.
      // Monatsmitte, damit keine Zeitzone den Monat verschieben kann.
      const first = new Date(Date.UTC(2000, 0, 15, 12))
      first.setUTCFullYear(year, month - 1, 15)
      current = { key, label: MONTH_FORMAT.format(first), entries: [] }
      months.push(current)
    }
    current.entries.push(entry)
  }
  return months
}
