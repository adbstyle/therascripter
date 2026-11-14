import type {
  RecentSearchQuery,
  SearchDocumentResult,
  SearchDossierResult,
  SearchHit,
  SearchQueryResult
} from '../../../../shared/types/Search'
import type { SessionFocus } from '../../navigation/routes'

/**
 * Einträge der Trefferliste in Anzeigereihenfolge (#209): ↑/↓ gehen durch
 * alle, ↵ öffnet den ausgewählten. Dossiers stehen getrennt und vor den
 * Inhalten (AK 24); je Sitzung bzw. PDF-Dokument ein Kopf (öffnet das
 * Dokument) und bis zu drei Fundstellen (öffnen die Stelle).
 */
export type SearchOption =
  | { key: string; kind: 'recent'; query: string }
  | { key: string; kind: 'dossier'; dossier: SearchDossierResult }
  | { key: string; kind: 'document'; doc: SearchDocumentResult }
  | { key: string; kind: 'hit'; doc: SearchDocumentResult; hit: SearchHit; index: number }

export function recentOptions(recent: RecentSearchQuery[]): SearchOption[] {
  return recent.map((r, i) => ({ key: `recent:${i}`, kind: 'recent', query: r.query }))
}

export function resultOptions(
  result: SearchQueryResult | null,
  { includeDossiers }: { includeDossiers: boolean }
): SearchOption[] {
  if (!result) return []
  const options: SearchOption[] = []
  if (includeDossiers) {
    for (const dossier of result.dossiers) {
      options.push({ key: `dossier:${dossier.id}`, kind: 'dossier', dossier })
    }
  }
  for (const doc of result.results) {
    options.push({ key: `doc:${doc.sessionId}`, kind: 'document', doc })
    doc.hits.forEach((hit, index) => {
      options.push({ key: `hit:${doc.sessionId}:${index}`, kind: 'hit', doc, hit, index })
    })
  }
  return options
}

/** Nächster Eintrag für ↑/↓; ohne Auswahl beginnt ↓ oben und ↑ unten. */
export function moveActive(
  options: SearchOption[],
  activeKey: string | null,
  direction: 1 | -1
): string | null {
  if (options.length === 0) return null
  const index = activeKey === null ? -1 : options.findIndex((o) => o.key === activeKey)
  if (index < 0) return options[direction === 1 ? 0 : options.length - 1].key
  const next = Math.min(options.length - 1, Math.max(0, index + direction))
  return options[next].key
}

export const UNTITLED_DOCUMENT = 'Transkription ohne Titel'

/** Id eines Eintrags für `aria-activedescendant`. */
export function optionId(listId: string, index: number): string {
  return `${listId}-option-${index}`
}

/** Stelle des Treffers links: Titel, Zusammenfassung, Sprecher · Zeit; PDFs ohne Seite. */
export function hitLabel(hit: SearchHit, type: 'audio' | 'pdf'): string {
  if (hit.field === 'title') return 'Titel'
  if (hit.field === 'summary') return 'Zusammenfassung'
  const parts = [hit.label.speaker, hit.label.timestamp].filter(Boolean)
  if (parts.length > 0) return parts.join(' · ')
  return type === 'pdf' ? 'Textstelle' : 'Transkript'
}

/** Ziel einer Fundstelle in der Route; Treffer alter Fassungen suchen über den Anker (#212). */
export function hitRouteFocus(hit: SearchHit): SessionFocus {
  return hit.fromEarlierVersion && hit.focus.kind === 'hit'
    ? { ...hit.focus, fromEarlierVersion: true }
    : hit.focus
}

/** Zähler gerenderter Zeilen — nur für den Leistungstest (#209, Review S5). */
export const searchRowRenders = { count: 0 }
