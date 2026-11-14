import { normalizeUmlaut } from './blocklist-matching'

/**
 * Normalisierung der Suche (#209 AK 3): Gross-/Kleinschreibung und die
 * Schreibweise von Umlauten spielen keine Rolle («Müller» = «mueller» =
 * «MÜLLER»). Dieselbe Regel wie `normalizeDossierKey`, nur ohne `trim` —
 * Texte behalten ihre Länge bis auf die Umlaut-Verlängerung.
 *
 * Einzige Implementierung: Indexierung, Anfrage, Dossier-Treffer und letzte
 * Suchanfragen normalisieren hier, SQL nie selbst (der Trigramm-Index sieht nur
 * bereits normalisierten Text).
 */

/** Unsichtbare Zeichen ohne Breite (wie dossier-normalize): zählen nie mit. */
const INVISIBLE = /[\u200B-\u200D\uFEFF]/g

export function normalizeSearchText(text: string): string {
  return normalizeUmlaut(text.normalize('NFC').replace(INVISIBLE, '').toLocaleLowerCase('de-CH'))
}

export interface NormalizedSearchText {
  normalized: string
  /**
   * `toOriginal[i]` = Position im Originaltext, aus der das Zeichen `i` des
   * normalisierten Texts stammt; dazu ein Endwächter (`toOriginal[n]` =
   * Länge des Originals). Ein Treffer `[a, b)` im normalisierten Text liegt im
   * Original bei `[toOriginal[a], toOriginal[b])`.
   */
  toOriginal: number[]
}

/** Basiszeichen samt folgender kombinierender Zeichen (z. B. `u` + U+0308). */
const CLUSTER = /\P{M}\p{M}*|\p{M}+/gu

/**
 * Wie normalizeSearchText, zusätzlich mit Offset-Tabelle zurück auf den
 * Originaltext (ä → ae verlängert, zerlegte Umlaute aus macOS-Eingaben
 * verkürzen). Gearbeitet wird pro Zeichen-Cluster, damit jede Position auf
 * einen Cluster-Anfang im Original zeigt und Markierungen nie mitten in einem
 * zusammengesetzten Zeichen beginnen.
 */
export function normalizeWithMap(text: string): NormalizedSearchText {
  const parts: string[] = []
  const toOriginal: number[] = []
  for (const match of text.matchAll(CLUSTER)) {
    const start = match.index ?? 0
    const out = normalizeSearchText(match[0])
    for (let i = 0; i < out.length; i++) toOriginal.push(start)
    parts.push(out)
  }
  toOriginal.push(text.length)
  return { normalized: parts.join(''), toOriginal }
}

/**
 * Bereiche `[start, end)` aller Vorkommen von `needle` (bereits normalisiert,
 * nicht leer) in `haystack`, auf das Original zurückgerechnet. Überlappende
 * Vorkommen zählen einzeln nicht doppelt: die Suche springt hinter jeden Fund.
 */
export function findNormalizedRanges(
  haystack: NormalizedSearchText,
  needle: string
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  if (needle.length === 0) return ranges
  let from = 0
  for (;;) {
    const at = haystack.normalized.indexOf(needle, from)
    if (at < 0) break
    const end = at + needle.length
    ranges.push({ start: haystack.toOriginal[at], end: originalEnd(haystack, end) })
    from = end
  }
  return ranges
}

/**
 * Ende eines Treffers im Original: Endet der Treffer mitten in der Ersetzung
 * eines Zeichens («ue» aus «ü», Anfrage «mu» in «müller»), gehört das ganze
 * Zeichen zur Markierung.
 */
function originalEnd(haystack: NormalizedSearchText, end: number): number {
  const { toOriginal } = haystack
  if (end >= toOriginal.length - 1) return toOriginal[toOriginal.length - 1]
  if (end > 0 && toOriginal[end] === toOriginal[end - 1]) {
    let next = end
    while (next < toOriginal.length - 1 && toOriginal[next] === toOriginal[end - 1]) next++
    return toOriginal[next]
  }
  return toOriginal[end]
}
