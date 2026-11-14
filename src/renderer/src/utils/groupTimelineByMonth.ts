import type { TimelineEntry } from '../../../shared/types/Dossier'

export interface TimelineMonth {
  /** `YYYY-MM` */
  key: string
  /** «November 2026» */
  label: string
  entries: TimelineEntry[]
}

const MONTH_FORMAT = new Intl.DateTimeFormat('de-CH', { month: 'long', year: 'numeric' })

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
      // setFullYear statt new Date(y, m, d): der Konstruktor deutet 0–99 als 1900–1999
      const first = new Date(2000, 0, 1)
      first.setFullYear(year, month - 1, 1)
      current = { key, label: MONTH_FORMAT.format(first), entries: [] }
      months.push(current)
    }
    current.entries.push(entry)
  }
  return months
}
