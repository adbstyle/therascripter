import Database from 'better-sqlite3'
import { applyTestSchema } from '../../db/__tests__/test-utils'
import { SearchIndexService } from '../SearchIndexService'

/** Gemeinsame Helfer der Such-Tests: DB im Speicher, Sitzungen, Dokumente. */

export function createSearchTestDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applyTestSchema(db)
  return db
}

export interface TestSessionInput {
  id: string
  type?: 'audio' | 'pdf'
  status?: string
  title?: string
  titlePlain?: string | null
  summary?: string | null
  createdAt?: string
  /** Zeitpunkt der letzten Änderung; Default weit in der Vergangenheit (ruhig). */
  updatedAt?: string
  documentDate?: string | null
  searchRev?: number
  deletingAt?: string | null
}

export function insertSession(db: Database.Database, input: TestSessionInput): void {
  db.prepare(
    `INSERT INTO sessions (id, title, type, status, anonymized_path, summary, title_plain,
       created_at, updated_at, document_date, search_rev, deleting_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.id,
    input.title ?? `Sitzung ${input.id}`,
    input.type ?? 'audio',
    input.status ?? 'review',
    `/docs/${input.id}.json`,
    input.summary ?? null,
    input.titlePlain ?? null,
    input.createdAt ?? '2026-01-01T10:00:00.000Z',
    input.updatedAt ?? '2026-01-01T10:00:00.000Z',
    input.documentDate ?? null,
    input.searchRev ?? 1,
    input.deletingAt ?? null
  )
}

export interface TestParagraph {
  speaker?: 'A' | 'B'
  /** Text mit Chips als `{{Original|TYP|Nummer}}` bzw. `{{|TYP|Nummer}}` (ohne Original). */
  text: string
  timestamp?: string
}

const CHIP = /\{\{([^|}]*)\|([A-Z]+)\|(\d+)\}\}/g

function inline(text: string): unknown[] {
  const nodes: unknown[] = []
  let last = 0
  for (const m of text.matchAll(CHIP)) {
    const at = m.index ?? 0
    if (at > last) nodes.push({ type: 'text', text: text.slice(last, at) })
    nodes.push({
      type: 'placeholderChip',
      attrs: {
        entityId: `${m[2]}-${m[3]}`,
        type: m[2],
        number: Number(m[3]),
        source: 'ner',
        original: m[1]
      }
    })
    last = at + m[0].length
  }
  if (last < text.length) nodes.push({ type: 'text', text: text.slice(last) })
  return nodes
}

export function makeDoc(paragraphs: TestParagraph[]): { type: 'doc'; content: unknown[] } {
  return {
    type: 'doc',
    content: paragraphs.map((p) => {
      const content: unknown[] = []
      if (p.speaker) {
        content.push({
          type: 'speakerLabel',
          attrs: { speaker: p.speaker, label: `Person ${p.speaker}` }
        })
        content.push({ type: 'text', text: ' ' })
      }
      if (p.timestamp) {
        content.push({ type: 'timestamp', attrs: { seconds: 0, formatted: p.timestamp } })
        content.push({ type: 'text', text: ' ' })
      }
      content.push(...inline(p.text))
      return { type: 'paragraph', content }
    })
  }
}

/** Dokumente per Pfad statt aus Dateien; `now` steuerbar. */
export function createIndexService(
  db: Database.Database,
  docs: Map<string, unknown>,
  now: () => number = () => Date.parse('2026-06-01T00:00:00.000Z')
): SearchIndexService {
  return new SearchIndexService(db, {
    now,
    readDocument: (path) => {
      if (!docs.has(path)) throw new Error(`ENOENT: ${path}`)
      return docs.get(path)
    }
  })
}

/** Legt eine fertig verarbeitete Sitzung mit Dokument an. */
export function addIndexedSession(
  db: Database.Database,
  docs: Map<string, unknown>,
  input: TestSessionInput,
  paragraphs: TestParagraph[]
): void {
  insertSession(db, input)
  docs.set(`/docs/${input.id}.json`, makeDoc(paragraphs))
}

/** Textphase vollständig durchlaufen lassen. */
export function indexAll(service: SearchIndexService): number {
  let total = 0
  for (let round = 0; round < 10_000; round++) {
    const { indexed, more } = service.runTextPhase(1000)
    total += indexed
    if (!more) return total
  }
  throw new Error('Textphase wird nicht fertig')
}
