import type Database from 'better-sqlite3'
import { SEARCH_VISIBLE_SESSION } from '../db/repositories/SearchIndexRepository'
import { SEARCH_COSINE_SLICE_MS } from '../../shared/search-config'
import type { SearchField } from '../../shared/types/Search'

/**
 * Vektoren der Suche nach Bedeutung im Main-Prozess (Epic #192 — #209;
 * Bauplan Abschnitte 3 und 5b).
 *
 * - int8 mit einer Skala pro Vektor, 768 Dimensionen: 48 MiB bei 66'000
 *   Abschnitten statt 194 MiB in float32; nDCG@10 auf dem Referenz-Set
 *   unverändert (0.570, Bauplan Abschnitt 3).
 * - Python bleibt zustandslos und liest die Datenbank nie: gelöschte Inhalte
 *   liegen so nie in einem fremden Prozess im Speicher.
 * - Geladen wird nur die aktive Vektorgeneration (`vec_gen`) des aktuellen
 *   Modells (`model_id`) sichtbarer Sitzungen — beim Öffnen der Suche,
 *   parallel zum Modellstart, in Scheiben; freigegeben mit dem Leerlauf des
 *   Suchprozesses.
 * - Synchron nachgeführt: ein Commit der Vektorphase ersetzt die Sitzung, ein
 *   Löschen (Markierung `deleting_at`) entfernt sie SOFORT (#209 PC 1).
 * - Pro Sitzung ein Block: Ersetzen und Entfernen sind eine Map-Operation,
 *   ohne Umkopieren aller Vektoren.
 *
 * Kosinus: Die Anfrage ist L2-normalisiert (Suchdienst). Für den
 * int8-Vektor q mit Skala s gilt cos(Anfrage, s·q) = (q·Anfrage) / ‖q‖ — die
 * Skala kürzt sich; gespeichert wird pro Vektor 1/‖q‖.
 */

/**
 * float32 → int8 an GENAU einer Stelle: symmetrisch, Skala = max|v| / 127,
 * q = round(v / Skala). Ein Nullvektor ergibt Skala 0.
 */
export function quantizeVector(vector: Float32Array): { q: Int8Array; scale: number } {
  let maxAbs = 0
  for (let i = 0; i < vector.length; i++) {
    const a = Math.abs(vector[i])
    if (a > maxAbs) maxAbs = a
  }
  const q = new Int8Array(vector.length)
  if (maxAbs === 0 || !Number.isFinite(maxAbs)) return { q, scale: 0 }
  const scale = maxAbs / 127
  for (let i = 0; i < vector.length; i++) {
    q[i] = Math.max(-127, Math.min(127, Math.round(vector[i] / scale)))
  }
  return { q, scale }
}

/** int8 + Skala → float32 (Tests, Diagnose). */
export function dequantizeVector(q: Int8Array, scale: number): Float32Array {
  const out = new Float32Array(q.length)
  for (let i = 0; i < q.length; i++) out[i] = q[i] * scale
  return out
}

/** Für die Spalte `search_chunks.vec`. */
export function vectorToBlob(q: Int8Array): Buffer {
  return Buffer.from(q.buffer, q.byteOffset, q.byteLength)
}

const FIELD_CODE: Record<SearchField, number> = { title: 0, summary: 1, body: 2 }
const FIELDS: SearchField[] = ['title', 'summary', 'body']

export interface VectorRow {
  chunkId: number
  field: SearchField
  ord: number
  paraFrom: number | null
  paraTo: number | null
  /** int8[dim] */
  vec: Int8Array
}

interface SessionBlock {
  sessionId: string
  n: number
  chunkIds: Int32Array
  fields: Uint8Array
  ords: Int32Array
  /** −1 = null */
  paraFrom: Int32Array
  paraTo: Int32Array
  vecs: Int8Array
  invNorms: Float32Array
}

export interface ScoredChunk {
  chunkId: number
  sessionId: string
  field: SearchField
  ord: number
  paraFrom: number | null
  paraTo: number | null
  cosine: number
}

export interface ScoreOptions {
  /** Nur Abschnitte mit Kosinus ≥ threshold; null = alle (Abnahmetest). */
  threshold: number | null
  /** Abbrechen zwischen zwei Scheiben (eine neuere Anfrage hat diese abgelöst). */
  isCancelled?: () => boolean
  /** Höchstens so lange am Stück rechnen. */
  sliceMs?: number
}

export class VectorStoreCancelledError extends Error {
  constructor() {
    super('Kosinus-Suche abgebrochen')
    this.name = 'VectorStoreCancelledError'
  }
}

interface DbRow {
  id: number
  field: SearchField
  ord: number
  para_from: number | null
  para_to: number | null
  vec: Buffer
}

const yieldToLoop = (): Promise<void> => new Promise((r) => setImmediate(r))

export class VectorStore {
  private sessions = new Map<string, SessionBlock>()
  private loadPromise: Promise<void> | null = null
  private loaded = false
  /** Steigt bei jeder Freigabe — ein laufendes Laden erkennt daran, dass es verworfen ist. */
  private epoch = 0
  private modelId: string | null = null

  constructor(
    private readonly db: Database.Database | null,
    readonly dim = 768
  ) {}

  get isLoaded(): boolean {
    return this.loaded
  }

  /** Geladen oder im Laden: dann führen Commits und Löschungen den Speicher nach. */
  get isActive(): boolean {
    return this.loaded || this.loadPromise !== null
  }

  get sessionCount(): number {
    return this.sessions.size
  }

  get chunkCount(): number {
    let n = 0
    for (const block of this.sessions.values()) n += block.n
    return n
  }

  /** Belegter Speicher der Vektoren in Bytes (Messungen). */
  get bytes(): number {
    let bytes = 0
    for (const b of this.sessions.values()) bytes += b.vecs.byteLength + b.n * 21
    return bytes
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  /**
   * Lädt die aktiven Vektoren aller sichtbaren Sitzungen des Modells, in
   * Scheiben (der Main-Prozess bleibt reaktionsfähig). Single-Flight; ein
   * zweiter Aufruf mit demselben Modell wartet auf das laufende Laden.
   */
  load(modelId: string): Promise<void> {
    if (this.modelId !== modelId) this.release()
    if (this.loaded) return Promise.resolve()
    if (this.loadPromise) return this.loadPromise
    this.modelId = modelId
    const epoch = this.epoch
    this.loadPromise = this.loadAll(epoch).finally(() => {
      if (this.epoch === epoch) this.loadPromise = null
    })
    return this.loadPromise
  }

  private async loadAll(epoch: number): Promise<void> {
    if (!this.db) {
      this.loaded = true
      return
    }
    const ids = this.db
      .prepare(
        `SELECT st.session_id FROM search_index_state st
         JOIN sessions s ON s.id = st.session_id
         WHERE st.vec_gen IS NOT NULL AND st.model_id = ? AND ${SEARCH_VISIBLE_SESSION}`
      )
      .pluck()
      .all(this.modelId) as string[]
    let sliceStart = performance.now()
    for (const id of ids) {
      if (this.epoch !== epoch) return
      // Schon nachgeführt (Commit während des Ladens) — die DB-Fassung ist dieselbe
      if (!this.sessions.has(id)) this.readSession(id)
      if (performance.now() - sliceStart > SEARCH_COSINE_SLICE_MS) {
        await yieldToLoop()
        sliceStart = performance.now()
      }
    }
    if (this.epoch === epoch) this.loaded = true
  }

  /** Speicher freigeben (Leerlauf des Suchprozesses, Beginn einer Verarbeitung). */
  release(): void {
    this.epoch++
    this.sessions.clear()
    this.loaded = false
    this.loadPromise = null
  }

  /**
   * Nach einem Commit der Vektorphase bzw. einer Änderung: die Sitzung aus der
   * DB neu lesen (aktive Vektorgeneration) oder entfernen, wenn sie keine hat
   * bzw. nicht mehr sichtbar ist. Synchron; nur wenn der Speicher aktiv ist.
   */
  refreshSession(sessionId: string): void {
    if (!this.isActive) return
    this.readSession(sessionId)
  }

  /** Sofort entfernen (gelöschte bzw. zum Löschen markierte Sitzung). */
  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  private readSession(sessionId: string): void {
    if (!this.db || this.modelId === null) return
    const rows = this.db
      .prepare(
        `SELECT c.id, c.field, c.ord, c.para_from, c.para_to, c.vec
         FROM search_chunks c
         JOIN search_index_state st ON st.session_id = c.session_id AND st.vec_gen = c.gen
         JOIN sessions s ON s.id = c.session_id
         WHERE c.session_id = ? AND st.model_id = ? AND c.vec IS NOT NULL
           AND ${SEARCH_VISIBLE_SESSION}
         ORDER BY c.id`
      )
      .all(sessionId, this.modelId) as DbRow[]
    if (rows.length === 0) {
      this.sessions.delete(sessionId)
      return
    }
    this.putSession(
      sessionId,
      rows.map((r) => ({
        chunkId: r.id,
        field: r.field,
        ord: r.ord,
        paraFrom: r.para_from,
        paraTo: r.para_to,
        vec: new Int8Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength)
      }))
    )
  }

  /** Vektoren einer Sitzung setzen (Laden, Tests). Leere Liste = entfernen. */
  putSession(sessionId: string, rows: VectorRow[]): void {
    const usable = rows.filter((r) => r.vec.length === this.dim)
    if (usable.length === 0) {
      this.sessions.delete(sessionId)
      return
    }
    const n = usable.length
    const block: SessionBlock = {
      sessionId,
      n,
      chunkIds: new Int32Array(n),
      fields: new Uint8Array(n),
      ords: new Int32Array(n),
      paraFrom: new Int32Array(n),
      paraTo: new Int32Array(n),
      vecs: new Int8Array(n * this.dim),
      invNorms: new Float32Array(n)
    }
    usable.forEach((row, i) => {
      block.chunkIds[i] = row.chunkId
      block.fields[i] = FIELD_CODE[row.field]
      block.ords[i] = row.ord
      block.paraFrom[i] = row.paraFrom ?? -1
      block.paraTo[i] = row.paraTo ?? -1
      block.vecs.set(row.vec, i * this.dim)
      let sq = 0
      for (let k = 0; k < this.dim; k++) sq += row.vec[k] * row.vec[k]
      block.invNorms[i] = sq > 0 ? 1 / Math.sqrt(sq) : 0
    })
    this.sessions.set(sessionId, block)
  }

  /**
   * Kosinus der Anfrage gegen alle Abschnitte, absteigend sortiert. Rechnet
   * in Scheiben von höchstens `sliceMs` und gibt dazwischen den Event-Loop
   * frei. Sitzungen, die währenddessen entfernt oder ersetzt wurden, fallen
   * heraus.
   */
  async score(query: Float32Array, options: ScoreOptions): Promise<ScoredChunk[]> {
    if (query.length !== this.dim) throw new Error('Anfragevektor mit falscher Dimension')
    const dim = this.dim
    const threshold = options.threshold
    const sliceMs = options.sliceMs ?? SEARCH_COSINE_SLICE_MS
    const blocks = [...this.sessions.values()]
    const hits: Array<{ block: SessionBlock; i: number; cosine: number }> = []
    let sliceStart = performance.now()
    for (const block of blocks) {
      const { vecs, invNorms, n } = block
      for (let i = 0; i < n; i++) {
        const base = i * dim
        let dot = 0
        let k = 0
        // Vierfach entrollt: ~30 ms für 66'000 × 768 auf einem M5 Pro
        for (; k + 3 < dim; k += 4) {
          dot +=
            vecs[base + k] * query[k] +
            vecs[base + k + 1] * query[k + 1] +
            vecs[base + k + 2] * query[k + 2] +
            vecs[base + k + 3] * query[k + 3]
        }
        for (; k < dim; k++) dot += vecs[base + k] * query[k]
        const cosine = dot * invNorms[i]
        if (threshold === null || cosine >= threshold) hits.push({ block, i, cosine })
      }
      if (performance.now() - sliceStart > sliceMs) {
        await yieldToLoop()
        if (options.isCancelled?.()) throw new VectorStoreCancelledError()
        sliceStart = performance.now()
      }
    }
    if (options.isCancelled?.()) throw new VectorStoreCancelledError()
    const result: ScoredChunk[] = []
    for (const { block, i, cosine } of hits) {
      // Während einer Pause entfernt oder ersetzt → nicht mehr gültig
      if (this.sessions.get(block.sessionId) !== block) continue
      result.push({
        chunkId: block.chunkIds[i],
        sessionId: block.sessionId,
        field: FIELDS[block.fields[i]],
        ord: block.ords[i],
        paraFrom: block.paraFrom[i] < 0 ? null : block.paraFrom[i],
        paraTo: block.paraTo[i] < 0 ? null : block.paraTo[i],
        cosine
      })
    }
    return result.sort((a, b) => b.cosine - a.cosine || a.chunkId - b.chunkId)
  }
}
