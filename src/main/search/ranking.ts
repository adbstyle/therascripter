import type { SearchField, SearchHitKind } from '../../shared/types/Search'
import { SEARCH_MAX_HITS_PER_DOCUMENT } from '../../shared/search-config'

/**
 * Ranking der Suche (Bauplan Abschnitt 6) als reine Funktionen.
 *
 * Eingabe sind Treffer-Abschnitte aus beliebigen Quellen: die exakte Suche
 * liefert `exact` (bm25), die Suche nach Bedeutung ab PR S4 `semantic`
 * (Kosinus) — für denselben Abschnitt dürfen beide gesetzt sein. S4 speist
 * seine Abschnitte hier ein, ohne die Funktion umzubauen; die Schwelle
 * (SEARCH_SEMANTIC_THRESHOLD) wendet S4 vorher an.
 *
 * Reihenfolge der Dokumente (#209 AK 8):
 * 1. Dokumente mit exaktem Treffer vor solchen nur nach Bedeutung
 *    (Dokument-Score `hasExact ? 1 + maxCos : maxCos`, gemessen 0.636).
 * 2. Innerhalb: höchster Kosinus, sofern beide einen haben.
 * 3. Ohne Modell: bester bm25 (kleiner = besser, SQLite-Konvention).
 * 4. Dann das neuere Datum, zuletzt die ID (stabile Reihenfolge).
 *
 * Gruppierung (#209 AK 7): jedes Dokument einmal, mit bis zu
 * SEARCH_MAX_HITS_PER_DOCUMENT Fundstellen; Abschnitte, deren Absätze sich
 * überschneiden (die wiederholte Unit), werden zu einer Fundstelle
 * zusammengefasst.
 *
 * Der Filter auf ein Patientendossier kommt NACH dieser Funktion (#211 AK 3):
 * die Reihenfolge ist dann identisch zur Suche über alle Inhalte.
 */

export interface ChunkCandidate {
  chunkId: number
  sessionId: string
  field: SearchField
  ord: number
  paraFrom: number | null
  paraTo: number | null
  /** Exakter Treffer: bm25 aus FTS5 (negativ, kleiner = besser); Scan: 0. */
  exact?: { bm25: number }
  /** Treffer nach Bedeutung (PR S4): Kosinus ≥ Schwelle. */
  semantic?: { cosine: number }
}

export interface RankedHit {
  /** Abschnitt, aus dem Ausschnitt und Markierungen stammen. */
  primary: ChunkCandidate
  /** Alle zusammengefassten Abschnitte (inkl. primary), Rangfolge. */
  merged: ChunkCandidate[]
  kind: SearchHitKind
  field: SearchField
  paraFrom: number | null
  paraTo: number | null
}

export interface RankedDocument {
  sessionId: string
  sortDay: string
  hasExact: boolean
  maxCosine: number | null
  bestBm25: number | null
  hits: RankedHit[]
}

const FIELD_ORDER: Record<SearchField, number> = { title: 0, summary: 1, body: 2 }

/** Vergleich zweier Abschnitte innerhalb eines Dokuments: passendster zuerst. */
export function compareChunks(a: ChunkCandidate, b: ChunkCandidate): number {
  const exact = Number(!!b.exact) - Number(!!a.exact)
  if (exact !== 0) return exact
  if (a.semantic && b.semantic && a.semantic.cosine !== b.semantic.cosine) {
    return b.semantic.cosine - a.semantic.cosine
  }
  if (a.exact && b.exact && a.exact.bm25 !== b.exact.bm25) return a.exact.bm25 - b.exact.bm25
  const field = FIELD_ORDER[a.field] - FIELD_ORDER[b.field]
  if (field !== 0) return field
  return a.ord - b.ord || a.chunkId - b.chunkId
}

/** Vergleich zweier Dokumente: passendstes zuerst. */
export function compareDocuments(a: RankedDocument, b: RankedDocument): number {
  const exact = Number(b.hasExact) - Number(a.hasExact)
  if (exact !== 0) return exact
  if (a.maxCosine !== null && b.maxCosine !== null && a.maxCosine !== b.maxCosine) {
    return b.maxCosine - a.maxCosine
  }
  if (a.bestBm25 !== null && b.bestBm25 !== null && a.bestBm25 !== b.bestBm25) {
    return a.bestBm25 - b.bestBm25
  }
  if (a.sortDay !== b.sortDay) return a.sortDay < b.sortDay ? 1 : -1
  return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0
}

function overlaps(a: ChunkCandidate, b: ChunkCandidate): boolean {
  if (a.field !== 'body' || b.field !== 'body') return false
  if (a.paraFrom === null || a.paraTo === null || b.paraFrom === null || b.paraTo === null) {
    return false
  }
  return a.paraFrom <= b.paraTo && b.paraFrom <= a.paraTo
}

/** Fundstellen eines Dokuments: bis zu `maxHits`, überlappende zusammengefasst. */
export function pickHits(
  candidates: ChunkCandidate[],
  maxHits = SEARCH_MAX_HITS_PER_DOCUMENT
): RankedHit[] {
  const hits: RankedHit[] = []
  for (const chunk of [...candidates].sort(compareChunks)) {
    const into = hits.find((hit) => hit.merged.some((m) => overlaps(m, chunk)))
    if (into) {
      into.merged.push(chunk)
      into.paraFrom = Math.min(into.paraFrom ?? Infinity, chunk.paraFrom ?? Infinity)
      into.paraTo = Math.max(into.paraTo ?? -Infinity, chunk.paraTo ?? -Infinity)
      continue
    }
    if (hits.length >= maxHits) continue
    hits.push({
      primary: chunk,
      merged: [chunk],
      kind: chunk.exact ? 'exact' : 'semantic',
      field: chunk.field,
      paraFrom: chunk.paraFrom,
      paraTo: chunk.paraTo
    })
  }
  return hits
}

/**
 * Gruppiert Treffer-Abschnitte pro Sitzung und sortiert die Dokumente.
 * Mehrfach gelieferte Abschnitte (exakt UND nach Bedeutung) werden vereinigt.
 */
export function rankDocuments(
  candidates: ChunkCandidate[],
  sortDayOf: (sessionId: string) => string,
  maxHits = SEARCH_MAX_HITS_PER_DOCUMENT
): RankedDocument[] {
  const byChunk = new Map<number, ChunkCandidate>()
  for (const c of candidates) {
    const known = byChunk.get(c.chunkId)
    if (!known) {
      byChunk.set(c.chunkId, { ...c })
      continue
    }
    if (c.exact && (!known.exact || c.exact.bm25 < known.exact.bm25)) known.exact = c.exact
    if (c.semantic && (!known.semantic || c.semantic.cosine > known.semantic.cosine)) {
      known.semantic = c.semantic
    }
  }

  const bySession = new Map<string, ChunkCandidate[]>()
  for (const c of byChunk.values()) {
    const list = bySession.get(c.sessionId)
    if (list) list.push(c)
    else bySession.set(c.sessionId, [c])
  }

  const documents: RankedDocument[] = []
  for (const [sessionId, chunks] of bySession) {
    let maxCosine: number | null = null
    let bestBm25: number | null = null
    let hasExact = false
    for (const c of chunks) {
      if (c.exact) {
        hasExact = true
        if (bestBm25 === null || c.exact.bm25 < bestBm25) bestBm25 = c.exact.bm25
      }
      if (c.semantic && (maxCosine === null || c.semantic.cosine > maxCosine)) {
        maxCosine = c.semantic.cosine
      }
    }
    documents.push({
      sessionId,
      sortDay: sortDayOf(sessionId),
      hasExact,
      maxCosine,
      bestBm25,
      hits: pickHits(chunks, maxHits)
    })
  }
  return documents.sort(compareDocuments)
}

/**
 * Filter auf ein Patientendossier NACH dem Ranking (#211 AK 3), danach der
 * Schnitt auf `limit`. `allowed` null = Suche über alle Inhalte.
 */
export function filterAndLimit(
  documents: RankedDocument[],
  allowed: ReadonlySet<string> | null,
  limit: number
): { documents: RankedDocument[]; truncated: boolean } {
  const filtered = allowed ? documents.filter((d) => allowed.has(d.sessionId)) : documents
  return { documents: filtered.slice(0, limit), truncated: filtered.length > limit }
}
