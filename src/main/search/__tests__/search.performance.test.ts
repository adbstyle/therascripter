import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type Database from 'better-sqlite3'
import { join } from 'path'
import { SearchService } from '../SearchService'
import { readFixtureDocs } from './chunker-fixture-docs'
import { createIndexService, createSearchTestDb, insertSession } from './helpers'

// Grössenordnung der exakten Suche und der Textphase (#209 AK 14 ohne Modell,
// #212 AK 2). Kleiner Bestand mit grosszügigem Budget; die Messung mit 2'000
// Sitzungen macht scripts/search-bench.ts (Werte in docs/product/features/search.md).

const SESSIONS = 200
const WORDS_PER_SESSION = 2000

function words(): string[] {
  const out: string[] = []
  for (const doc of readFixtureDocs(join(__dirname, 'fixtures', 'chunker-docs'))) {
    for (const paragraph of doc.document.content as Array<{ content: Array<{ text?: string }> }>) {
      for (const node of paragraph.content) if (node.text) out.push(...node.text.split(/\s+/))
    }
  }
  return out.filter(Boolean)
}

describe('search performance (small stock, generous budget)', () => {
  let db: Database.Database
  const perSession: number[] = []

  beforeAll(() => {
    db = createSearchTestDb()
    const vocab = words()
    const docs = new Map<string, unknown>()
    for (let i = 0; i < SESSIONS; i++) {
      const id = `s${i}`
      insertSession(db, {
        id,
        createdAt: new Date(Date.UTC(2025, 0, 1) + i * 86_400_000).toISOString()
      })
      const content: unknown[] = []
      for (let w = 0, turn = 0; w < WORDS_PER_SESSION; w += 30, turn++) {
        const start = (i * 7919 + turn * 104729) % (vocab.length - 30)
        content.push({
          type: 'paragraph',
          content: [
            { type: 'speakerLabel', attrs: { speaker: turn % 2 ? 'B' : 'A', label: 'Person' } },
            { type: 'text', text: ` ${vocab.slice(start, start + 30).join(' ')}` }
          ]
        })
      }
      docs.set(`/docs/${id}.json`, { type: 'doc', content })
    }
    const service = createIndexService(db, docs)
    for (;;) {
      const t = performance.now()
      const { indexed, more } = service.runTextPhase(1)
      if (indexed > 0) perSession.push(performance.now() - t)
      if (!more) break
    }
  })

  afterAll(() => db.close())

  it('indexes a session in well under a second', () => {
    expect(perSession).toHaveLength(SESSIONS)
    const sorted = [...perSession].sort((a, b) => a - b)
    expect(sorted[Math.floor(sorted.length / 2)]).toBeLessThan(250)
  })

  it('answers typical exact queries in well under the 2-second budget', () => {
    const search = new SearchService(db)
    for (const query of ['schlaf', 'ich habe', 'Brunner', 'und', 'ab', 'xq']) {
      const t = performance.now()
      const result = search.query({ requestId: 1, query, scope: { kind: 'all' } })
      const ms = performance.now() - t
      expect(ms, query).toBeLessThan(1500)
      expect(result.requestId).toBe(1)
    }
  })
})
