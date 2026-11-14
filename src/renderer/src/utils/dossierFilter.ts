import { normalizeDossierKey } from '../../../shared/utils/dossier-normalize'
import type { DossierListItem } from '../../../shared/types/Dossier'

/** Übersichtszeile mit einmal vorberechneten Vergleichsschlüsseln. */
export interface PreparedDossier {
  item: DossierListItem
  firstNorm: string
  lastNorm: string
}

/**
 * Normalisiert alle Namen EINMAL pro Liste (#204 AK 15): beim Tippen im Filter
 * wird dann nur noch verglichen, nicht für jede Zeile neu normalisiert.
 */
export function prepareDossierFilter(items: DossierListItem[]): PreparedDossier[] {
  return items.map((item) => ({
    item,
    firstNorm: normalizeDossierKey(item.firstName),
    lastNorm: normalizeDossierKey(item.lastName)
  }))
}

/**
 * Filter der Übersicht nach Vor- und Nachnamen (#204 AK 14): Jeder Suchteil
 * muss in Vor- ODER Nachnamen vorkommen, auch als Teil eines Namens — «ann mei»
 * findet «Anna Meier», «mül» findet «Mueller». Gleichheit wie überall bei
 * Dossiers über `normalizeDossierKey` (Gross-/Kleinschreibung, Umlaute).
 * Die Reihenfolge der Liste (alphabetisch nach Nachnamen) bleibt erhalten.
 */
export function filterDossiers(prepared: PreparedDossier[], query: string): DossierListItem[] {
  const parts = normalizeDossierKey(query).split(/\s+/).filter(Boolean)
  if (parts.length === 0) return prepared.map((p) => p.item)
  const result: DossierListItem[] = []
  for (const p of prepared) {
    if (parts.every((part) => p.firstNorm.includes(part) || p.lastNorm.includes(part))) {
      result.push(p.item)
    }
  }
  return result
}
