import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { SearchIndexService, type VectorPhaseDeps } from '../SearchIndexService'
import { SearchWorkerUnavailableError } from '../SearchWorker'
import { addIndexedSession, createSearchTestDb, indexAll } from './helpers'
import { TEST_MODEL, fakeEmbed } from './semanticHelpers'
import type { SearchModelInfo } from '../searchModel'

// Vektorphase der Aufbereitung (PR S4): Batches zu 2, Commit pro Batch,
// Abschluss vec_gen = text_gen, Backoff, Vorrang, Abbruch, Modellwechsel.

const NOW = Date.parse('2026-06-01T00:00:00.000Z')

interface Harness {
  db: Database.Database
  docs: Map<string, unknown>
  service: SearchIndexService
  calls: string[][]
  changed: string[]
  flags: { processing: boolean; model: SearchModelInfo | null }
  clock: { now: number }
  embed: { impl: (texts: string[]) => Promise<Float32Array[]> }
  activity: boolean[]
}

function setup(): Harness {
  const db = createSearchTestDb()
  const docs = new Map<string, unknown>()
  const calls: string[][] = []
  const changed: string[] = []
  const activity: boolean[] = []
  const flags = { processing: false, model: TEST_MODEL as SearchModelInfo | null }
  const clock = { now: NOW }
  const embed = {
    impl: async (texts: string[]): Promise<Float32Array[]> => texts.map((t) => fakeEmbed(t))
  }
  const vectors: VectorPhaseDeps = {
    resolveModel: () => flags.model,
    isProcessingActive: () => flags.processing,
    embedDocuments: (texts) => {
      calls.push(texts)
      return embed.impl(texts)
    },
    onSessionVectorsChanged: (id) => changed.push(id),
    onActiveChange: (active) => activity.push(active)
  }
  const service = new SearchIndexService(db, {
    now: () => clock.now,
    readDocument: (path) => {
      if (!docs.has(path)) throw new Error(`ENOENT: ${path}`)
      return docs.get(path)
    },
    vectors
  })
  return { db, docs, service, calls, changed, flags, clock, embed, activity }
}

function longParagraphs(n: number, word: string): Array<{ speaker: 'A' | 'B'; text: string }> {
  return Array.from({ length: n }, (_, i) => ({
    speaker: i % 2 === 0 ? ('A' as const) : ('B' as const),
    text: `${word} ${'Satz mit einigen Wörtern über den Alltag. '.repeat(10 + (i % 4))}`.trim()
  }))
}

function state(db: Database.Database, id: string) {
  return db
    .prepare(
      'SELECT text_gen, vec_gen, model_id, attempts, next_attempt_at, last_error FROM search_index_state WHERE session_id = ?'
    )
    .get(id) as {
    text_gen: number
    vec_gen: number | null
    model_id: string | null
    attempts: number
    next_attempt_at: string | null
    last_error: string | null
  }
}

function pendingVectors(db: Database.Database, id: string, gen: number): number {
  return (
    db
      .prepare(
        'SELECT COUNT(*) AS n FROM search_chunks WHERE session_id = ? AND gen = ? AND vec IS NULL'
      )
      .get(id, gen) as { n: number }
  ).n
}

describe('SearchIndexService — Vektorphase', () => {
  let h: Harness

  beforeEach(() => {
    h = setup()
  })

  afterEach(() => {
    h.service.stop()
    h.db.close()
  })

  it('embeds every chunk in batches of 2 (longest first) and activates vec_gen = text_gen', async () => {
    addIndexedSession(
      h.db,
      h.docs,
      { id: 's1', title: 'Erstgespräch', summary: 'Kurz.' },
      longParagraphs(12, 'Schlaf')
    )
    indexAll(h.service)
    const textGen = state(h.db, 's1').text_gen
    const chunks = (
      h.db
        .prepare('SELECT COUNT(*) AS n FROM search_chunks WHERE session_id = ? AND gen = ?')
        .get('s1', textGen) as { n: number }
    ).n
    expect(chunks).toBeGreaterThan(3)

    expect(await h.service.runVectorPhaseToEnd()).toBe(1)
    expect(h.calls.every((c) => c.length <= 2)).toBe(true)
    expect(h.calls.flat()).toHaveLength(chunks)
    const lengths = h.calls.flat().map((t) => t.length)
    expect(lengths).toEqual([...lengths].sort((a, b) => b - a))
    // Der Text für das Modell ist der Abschnittstext MIT Sprecher-Präfix (wie im Spike)
    expect(h.calls.flat().some((t) => t.startsWith('Sprecher 1: Schlaf'))).toBe(true)

    expect(state(h.db, 's1')).toMatchObject({
      vec_gen: textGen,
      model_id: 'test-model',
      attempts: 0
    })
    expect(pendingVectors(h.db, 's1', textGen)).toBe(0)
    const row = h.db
      .prepare('SELECT vec, vec_scale FROM search_chunks WHERE session_id = ? AND gen = ? LIMIT 1')
      .get('s1', textGen) as { vec: Buffer; vec_scale: number }
    expect(row.vec.length).toBe(768)
    expect(row.vec_scale).toBeGreaterThan(0)
    expect(h.changed).toEqual(['s1'])
  })

  it('commits per batch: after a failure the done batches stay and only the rest is embedded later (backoff 1 min, then 5 min)', async () => {
    addIndexedSession(h.db, h.docs, { id: 's1' }, longParagraphs(12, 'Arbeit'))
    indexAll(h.service)
    const textGen = state(h.db, 's1').text_gen
    const total = pendingVectors(h.db, 's1', textGen)
    let n = 0
    h.embed.impl = async (texts) => {
      if (++n === 2) throw new Error('Suchdienst: internal: kaputt')
      return texts.map((t) => fakeEmbed(t))
    }
    expect(await h.service.runVectorPhaseToEnd()).toBe(0)
    expect(pendingVectors(h.db, 's1', textGen)).toBe(total - 2)
    const failed = state(h.db, 's1')
    expect(failed).toMatchObject({
      attempts: 1,
      vec_gen: null,
      last_error: 'Suchdienst: internal: kaputt'
    })
    expect(failed.next_attempt_at).toBe(new Date(NOW + 60_000).toISOString())

    // Im Backoff: nichts
    h.calls.length = 0
    expect(await h.service.runVectorPhaseToEnd()).toBe(0)
    expect(h.calls).toHaveLength(0)

    // Zweiter Fehler → 5 min
    h.clock.now = NOW + 61_000
    n = 1
    expect(await h.service.runVectorPhaseToEnd()).toBe(0)
    expect(state(h.db, 's1').next_attempt_at).toBe(
      new Date(NOW + 61_000 + 5 * 60_000).toISOString()
    )

    // Danach gelingt es: nur die fehlenden Abschnitte, Versuche zurückgesetzt
    h.clock.now = NOW + 61_000 + 5 * 60_000 + 1
    h.embed.impl = async (texts) => texts.map((t) => fakeEmbed(t))
    h.calls.length = 0
    expect(await h.service.runVectorPhaseToEnd()).toBe(1)
    expect(h.calls.flat()).toHaveLength(total - 2)
    expect(state(h.db, 's1')).toMatchObject({
      vec_gen: textGen,
      attempts: 0,
      next_attempt_at: null
    })
  })

  it('progress survives a restart: a new service instance continues where the old one stopped', async () => {
    addIndexedSession(h.db, h.docs, { id: 's1' }, longParagraphs(12, 'Familie'))
    indexAll(h.service)
    const textGen = state(h.db, 's1').text_gen
    const total = pendingVectors(h.db, 's1', textGen)
    let n = 0
    h.embed.impl = async (texts) => {
      if (++n === 2) {
        // «App beendet» mitten in der Vektorphase
        h.service.stop()
      }
      return texts.map((t) => fakeEmbed(t))
    }
    await h.service.runVectorPhaseToEnd()
    expect(pendingVectors(h.db, 's1', textGen)).toBe(total - 2)

    const calls: string[][] = []
    const restarted = new SearchIndexService(h.db, {
      now: () => NOW,
      readDocument: (p) => h.docs.get(p),
      vectors: {
        resolveModel: () => TEST_MODEL,
        isProcessingActive: () => false,
        embedDocuments: async (texts) => {
          calls.push(texts)
          return texts.map((t) => fakeEmbed(t))
        }
      }
    })
    expect(await restarted.runVectorPhaseToEnd()).toBe(1)
    expect(calls.flat()).toHaveLength(total - 2)
    restarted.stop()
  })

  it('handles changed and new sessions before the stock, newest first', async () => {
    addIndexedSession(
      h.db,
      h.docs,
      { id: 'alt-1', searchRev: 0, updatedAt: '2025-01-01T10:00:00.000Z' },
      [{ text: 'Altbestand eins' }]
    )
    addIndexedSession(
      h.db,
      h.docs,
      { id: 'alt-2', searchRev: 0, updatedAt: '2025-02-01T10:00:00.000Z' },
      [{ text: 'Altbestand zwei' }]
    )
    addIndexedSession(
      h.db,
      h.docs,
      { id: 'neu-1', searchRev: 1, updatedAt: '2026-01-01T10:00:00.000Z' },
      [{ text: 'Neu eins' }]
    )
    addIndexedSession(
      h.db,
      h.docs,
      { id: 'neu-2', searchRev: 2, updatedAt: '2026-03-01T10:00:00.000Z' },
      [{ text: 'Neu zwei' }]
    )
    indexAll(h.service)
    await h.service.runVectorPhaseToEnd()
    expect(h.changed).toEqual(['neu-2', 'neu-1', 'alt-2', 'alt-1'])
  })

  it('keeps the previous vector generation active until the new one is complete, then cleans it up', async () => {
    addIndexedSession(h.db, h.docs, { id: 's1' }, longParagraphs(8, 'Angst'))
    indexAll(h.service)
    await h.service.runVectorPhaseToEnd()
    const first = state(h.db, 's1').text_gen

    // Bearbeitung: neue Textgeneration
    h.docs.set('/docs/s1.json', (await import('./helpers')).makeDoc(longParagraphs(8, 'Freude')))
    h.db.prepare('UPDATE sessions SET search_rev = search_rev + 1 WHERE id = ?').run('s1')
    indexAll(h.service)
    const second = state(h.db, 's1').text_gen
    expect(second).toBeGreaterThan(first)
    expect(state(h.db, 's1').vec_gen).toBe(first)

    // Halb fertig: die alte Vektorgeneration bleibt aktiv
    let n = 0
    h.embed.impl = async (texts) => {
      if (++n === 2) throw new Error('kaputt')
      return texts.map((t) => fakeEmbed(t))
    }
    await h.service.runVectorPhaseToEnd()
    expect(state(h.db, 's1').vec_gen).toBe(first)
    h.service.drain()
    expect(
      (
        h.db
          .prepare('SELECT COUNT(*) AS n FROM search_chunks WHERE session_id = ? AND gen = ?')
          .get('s1', first) as { n: number }
      ).n
    ).toBeGreaterThan(0)

    h.embed.impl = async (texts) => texts.map((t) => fakeEmbed(t))
    h.clock.now = NOW + 120_000
    await h.service.runVectorPhaseToEnd()
    expect(state(h.db, 's1').vec_gen).toBe(second)
    h.service.drain()
    expect(
      (
        h.db
          .prepare('SELECT COUNT(*) AS n FROM search_chunks WHERE session_id = ? AND gen = ?')
          .get('s1', first) as { n: number }
      ).n
    ).toBe(0)
  })

  it('a different model makes all vectors stale and embeds the session again', async () => {
    addIndexedSession(h.db, h.docs, { id: 's1' }, longParagraphs(6, 'Trauer'))
    indexAll(h.service)
    await h.service.runVectorPhaseToEnd()
    const total = h.calls.flat().length
    h.calls.length = 0
    h.flags.model = { ...TEST_MODEL, modelId: 'anderes-modell' }
    await h.service.runVectorPhaseToEnd()
    expect(h.calls.flat()).toHaveLength(total)
    expect(state(h.db, 's1')).toMatchObject({ model_id: 'anderes-modell' })
  })

  it('does not run while processing is active, during a recording or without the model', async () => {
    addIndexedSession(h.db, h.docs, { id: 's1' }, [{ text: 'Etwas Text hier' }])
    indexAll(h.service)
    h.flags.processing = true
    expect(await h.service.runVectorPhaseToEnd()).toBe(0)
    h.flags.processing = false
    h.service.setRecordingPause(true)
    expect(await h.service.runVectorPhaseToEnd()).toBe(0)
    h.service.setRecordingPause(false)
    h.flags.model = null
    expect(await h.service.runVectorPhaseToEnd()).toBe(0)
    expect(h.calls).toHaveLength(0)
  })

  it('aborts at once when processing begins: the in-flight batch is not written, no attempt counted', async () => {
    addIndexedSession(h.db, h.docs, { id: 's1' }, longParagraphs(12, 'Konflikt'))
    indexAll(h.service)
    const textGen = state(h.db, 's1').text_gen
    const total = pendingVectors(h.db, 's1', textGen)
    let release: () => void = () => {}
    h.embed.impl = (texts) =>
      new Promise((resolve) => {
        release = () => resolve(texts.map((t) => fakeEmbed(t)))
      })
    h.service.start()
    await new Promise((r) => setTimeout(r, 20))
    expect(h.service.isVectorPhaseRunning()).toBe(true)
    h.flags.processing = true
    const aborted = h.service.abortVectorPhase()
    release()
    await aborted
    expect(h.service.isVectorPhaseRunning()).toBe(false)
    expect(pendingVectors(h.db, 's1', textGen)).toBe(total)
    expect(state(h.db, 's1').attempts).toBe(0)
  })

  it('a stopped worker (processing) does not count as a failure of the session', async () => {
    addIndexedSession(h.db, h.docs, { id: 's1' }, [{ text: 'Etwas Text hier' }])
    indexAll(h.service)
    h.embed.impl = async () => {
      throw new SearchWorkerUnavailableError('processing')
    }
    await h.service.runVectorPhaseToEnd()
    expect(state(h.db, 's1')).toMatchObject({ attempts: 0, vec_gen: null })
  })

  it('counts only failures caused by the batch itself (crash/timeout during the request)', async () => {
    addIndexedSession(h.db, h.docs, { id: 's1' }, [{ text: 'Etwas Text hier' }])
    indexAll(h.service)
    for (const kind of ['start', 'cooldown', 'blocked', 'stopping'] as const) {
      h.embed.impl = async () => {
        throw new SearchWorkerUnavailableError('error', 'x', kind)
      }
      await h.service.runVectorPhaseToEnd()
      expect(state(h.db, 's1').attempts).toBe(0)
    }
    h.embed.impl = async () => {
      throw new SearchWorkerUnavailableError('error', 'abgestürzt', 'request')
    }
    await h.service.runVectorPhaseToEnd()
    expect(state(h.db, 's1')).toMatchObject({ attempts: 1, last_error: 'abgestürzt' })
  })

  it('reports start and end of its work (the idle timer of the search process)', async () => {
    addIndexedSession(h.db, h.docs, { id: 's1' }, [{ text: 'Etwas Text hier' }])
    indexAll(h.service)
    await h.service.runVectorPhaseToEnd()
    expect(h.activity).toEqual([true, false])
    // Nichts zu tun: keine Meldung
    await h.service.runVectorPhaseToEnd()
    expect(h.activity).toEqual([true, false])
  })

  it('a recording ends the work at once and reports it (the process may then end)', async () => {
    addIndexedSession(h.db, h.docs, { id: 's1' }, longParagraphs(12, 'Arbeit'))
    indexAll(h.service)
    let release: () => void = () => {}
    h.embed.impl = (texts) =>
      new Promise((resolve) => {
        release = () => resolve(texts.map((t) => fakeEmbed(t)))
      })
    const run = h.service.runVectorPhaseToEnd()
    await new Promise((r) => setTimeout(r, 10))
    expect(h.activity).toEqual([true])
    h.service.setRecordingPause(true)
    release()
    await run
    expect(h.activity).toEqual([true, false])
  })

  it('sends no further section of a session deleted during the run', async () => {
    addIndexedSession(h.db, h.docs, { id: 's1' }, longParagraphs(12, 'Geheimnis'))
    indexAll(h.service)
    let n = 0
    h.embed.impl = async (texts) => {
      if (++n === 1) {
        h.db.prepare("UPDATE sessions SET deleting_at = 'x' WHERE id = 's1'").run()
        h.service.noteSessionsDeleted(['s1'])
      }
      return texts.map((t) => fakeEmbed(t))
    }
    await h.service.runVectorPhaseToEnd()
    expect(h.calls).toHaveLength(1)
  })

  it('an edit during a running batch: superseded, old vectors stay active, new not marked current', async () => {
    addIndexedSession(h.db, h.docs, { id: 's1' }, longParagraphs(4, 'Angst'))
    indexAll(h.service)
    await h.service.runVectorPhaseToEnd()
    const first = state(h.db, 's1').text_gen
    h.docs.set('/docs/s1.json', (await import('./helpers')).makeDoc(longParagraphs(4, 'Ruhe')))
    h.db.prepare('UPDATE sessions SET search_rev = search_rev + 1 WHERE id = ?').run('s1')
    indexAll(h.service)
    const second = state(h.db, 's1').text_gen
    let n = 0
    h.embed.impl = async (texts) => {
      if (++n === 1) {
        // Bearbeitung mitten im Batch: dritte Textgeneration
        h.docs.set('/docs/s1.json', (await import('./helpers')).makeDoc(longParagraphs(4, 'Wut')))
        h.db.prepare('UPDATE sessions SET search_rev = search_rev + 1 WHERE id = ?').run('s1')
        indexAll(h.service)
      }
      return texts.map((t) => fakeEmbed(t))
    }
    h.changed.length = 0
    await h.service.runVectorPhaseToEnd()
    const third = state(h.db, 's1').text_gen
    expect(third).toBeGreaterThan(second)
    // Die zweite Generation wurde nie aktiv; am Ende ist die dritte fertig
    expect(state(h.db, 's1').vec_gen).toBe(third)
    expect(h.changed).toEqual(['s1'])
    expect(first).toBeLessThan(second)
  })
})
