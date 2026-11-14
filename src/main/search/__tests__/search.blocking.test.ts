import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Review #222, Befund 1: Löschen im FTS-Index mit 'secure-delete' kostet
// ~40 ms pro Abschnitt. Neuindexierung nach einer Bearbeitung und Löschen
// einer grossen Sitzung dürfen den Main-Prozess trotzdem nicht am Stück
// blockieren: kein einzelner synchroner Schritt über ~100 ms (Budget hier
// grosszügiger, damit die CI nicht flackert; Messwerte mit 2'000 Sitzungen:
// scripts/search-bench.ts, docs/product/features/search.md).

const home = vi.hoisted(() => ({ path: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => home.path },
  BrowserWindow: { getAllWindows: () => [] }
}))

import { applyTestSchema } from '../../db/__tests__/test-utils'
import { SessionService } from '../../services/SessionService'
import { initSearchIndexService, resetSearchIndexServiceForTests } from '../SearchIndexService'
import type { SearchIndexService } from '../SearchIndexService'
import { readFixtureDocs } from './chunker-fixture-docs'
import { insertSession } from './helpers'

const BUDGET_MS = 400
const SESSIONS = 150

function vocabulary(): string[] {
  const out: string[] = []
  for (const doc of readFixtureDocs(join(__dirname, 'fixtures', 'chunker-docs'))) {
    for (const p of doc.document.content as Array<{ content: Array<{ text?: string }> }>) {
      for (const node of p.content) if (node.text) out.push(...node.text.split(/\s+/))
    }
  }
  return out.filter(Boolean)
}

function makeDoc(vocab: string[], words: number, seed: number): unknown {
  const content: unknown[] = []
  for (let w = 0, turn = 0; w < words; w += 30, turn++) {
    const start = (seed * 7919 + turn * 104729) % (vocab.length - 30)
    content.push({
      type: 'paragraph',
      content: [
        { type: 'speakerLabel', attrs: { speaker: turn % 2 ? 'B' : 'A', label: 'Person' } },
        { type: 'text', text: ` ${vocab.slice(start, start + 30).join(' ')} ${seed}x${turn}` }
      ]
    })
  }
  return { type: 'doc', content }
}

function timed(fn: () => unknown): number {
  const t = performance.now()
  fn()
  return performance.now() - t
}

describe('search index — no long synchronous blocks (review #222)', () => {
  let db: Database.Database
  let indexer: SearchIndexService
  const docs = new Map<string, unknown>()
  let vocab: string[]

  /** Schleife bis zum Ende treiben; längste Scheibe zurückgeben. */
  function drainMax(): { max: number; slices: number } {
    let max = 0
    let slices = 0
    for (;;) {
      let more = false
      max = Math.max(
        max,
        timed(() => (more = indexer.runSlice().more))
      )
      slices++
      if (!more) return { max, slices }
    }
  }

  beforeAll(() => {
    home.path = mkdtempSync(join(tmpdir(), 'search-blocking-'))
    db = new Database(join(home.path, 'blocking.db'))
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    db.pragma('secure_delete = ON')
    applyTestSchema(db)
    vocab = vocabulary()
    for (let i = 0; i < SESSIONS; i++) {
      insertSession(db, { id: `s${i}` })
      docs.set(`/docs/s${i}.json`, makeDoc(vocab, 2000, i))
    }
    // Eine 2-Stunden-Sitzung (~18'000 Wörter)
    insertSession(db, { id: 'big' })
    docs.set('/docs/big.json', makeDoc(vocab, 18_000, 9999))
    indexer = initSearchIndexService(db, {
      now: () => Date.now() + 60_000,
      readDocument: (path) => docs.get(path),
      statDocument: () => null,
      finishDeletion: (id) => {
        new SessionService(db).finishDeletion(id)
      }
    })
    indexer.start()
    drainMax()
  })

  afterAll(() => {
    resetSearchIndexServiceForTests()
    db.close()
    rmSync(home.path, { recursive: true, force: true })
  })

  it('re-indexes a two-hour session after an edit in short slices', () => {
    const before = (
      db.prepare(`SELECT COUNT(*) AS n FROM search_chunks WHERE session_id = 'big'`).get() as {
        n: number
      }
    ).n
    expect(before).toBeGreaterThan(70)
    docs.set('/docs/big.json', makeDoc(vocab, 18_000, 4242))
    db.prepare(`UPDATE sessions SET search_rev = search_rev + 1 WHERE id = 'big'`).run()
    const { max, slices } = drainMax()
    console.log(
      `[blocking] Neuindexierung 2 h (${before} Abschnitte): längste Scheibe ${max.toFixed(1)} ms, ${slices} Scheiben`
    )
    expect(max).toBeLessThan(BUDGET_MS)
    const gens = db.prepare(`SELECT DISTINCT gen FROM search_chunks WHERE session_id = 'big'`).all()
    expect(gens).toEqual([{ gen: 2 }])
  })

  it('deletes a large session without blocking the IPC call and completes on its own', () => {
    const sessions = new SessionService(db)
    const call = timed(() => sessions.deleteSession('big'))
    const { max, slices } = drainMax()
    console.log(
      `[blocking] Löschen 2 h: Aufruf ${call.toFixed(1)} ms, längste Scheibe ${max.toFixed(1)} ms, ${slices} Scheiben`
    )
    expect(call).toBeLessThan(BUDGET_MS)
    expect(max).toBeLessThan(BUDGET_MS)
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE id = 'big'`).get()).toEqual({
      n: 0
    })
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM search_chunks WHERE session_id = 'big'`).get()
    ).toEqual({ n: 0 })
  })
})
