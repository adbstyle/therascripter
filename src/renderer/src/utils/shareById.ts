/**
 * Strukturelles Teilen für nachgeladene Listen (#205, Review #223): Einträge,
 * deren Inhalt sich nicht geändert hat, behalten ihre bisherige
 * Objekt-Identität — memoisierte Karten rendern dann nicht neu. Hat sich gar
 * nichts geändert, kommt die bisherige Liste selbst zurück.
 *
 * Vergleich über JSON: die Einträge sind reine Daten aus dem IPC.
 */
export function shareById<T extends { id: string }>(prev: readonly T[], next: T[]): T[] {
  const previous = new Map<string, { item: T; json: string }>()
  for (const item of prev) previous.set(item.id, { item, json: JSON.stringify(item) })
  let unchanged = prev.length === next.length
  const result = next.map((item, index) => {
    const old = previous.get(item.id)
    if (old && old.json === JSON.stringify(item)) {
      if (prev[index] !== old.item) unchanged = false
      return old.item
    }
    unchanged = false
    return item
  })
  return unchanged ? (prev as T[]) : result
}
