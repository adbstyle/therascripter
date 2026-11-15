import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { SearchService } from '../SearchService'
import { parseQuery, ftsExpression } from '../exactSearch'
import type { SearchHit, SearchQueryResult, SearchScope } from '../../../shared/types/Search'
import { SEARCH_SHORT_QUERY_MAX_CHUNKS } from '../../../shared/search-config'
import {
  addIndexedSession,
  createIndexService,
  createSearchTestDb,
  indexAll,
  insertSession
} from './helpers'

function markedText(hit: SearchHit): string[] {
  return hit.snippet.marks.map((m) => hit.snippet.text.slice(m.start, m.end))
}

describe('parseQuery', () => {
  it('uses words with ≥ 3 characters as trigram phrases, ignoring punctuation at the edges', () => {
    expect(parseQuery('Ich habe Angst, oder?')).toEqual({
      terms: ['ich', 'habe', 'angst', 'oder'],
      mode: 'fts'
    })
    expect(parseQuery('an im Zug')).toEqual({ terms: ['zug'], mode: 'fts' })
    expect(parseQuery('Öl ab')).toEqual({ terms: ['oel'], mode: 'fts' })
    expect(parseQuery('ab')).toEqual({ terms: ['ab'], mode: 'scan' })
    expect(parseQuery(' ?! ')).toEqual({ terms: [], mode: 'none' })
    expect(ftsExpression(['a"b', 'cde'])).toBe('"a""b" AND "cde"')
  })
})

describe('SearchService — exact search', () => {
  let db: Database.Database
  let docs: Map<string, unknown>
  let service: SearchService

  function search(query: string, scope: SearchScope = { kind: 'all' }): SearchQueryResult {
    return service.query({ requestId: 7, query, scope })
  }

  beforeEach(() => {
    db = createSearchTestDb()
    docs = new Map()
    service = new SearchService(db)
  })

  afterEach(() => db.close())

  function seed(): void {
    addIndexedSession(
      db,
      docs,
      {
        id: 'meier',
        title: 'Erstgespräch [PERSON 1]',
        titlePlain: 'Erstgespräch Sandra Meier',
        summary: 'Es ging um die Prüfungsangst vor dem Examen.',
        createdAt: '2026-03-04T09:00:00.000Z'
      },
      [
        {
          speaker: 'A',
          timestamp: '00:00:05',
          text: 'Guten Tag {{Sandra Meier|PERSON|1}}, wie geht es Ihnen?'
        },
        {
          speaker: 'B',
          timestamp: '00:00:12',
          text: 'Die PRÜFUNGSANGST ist schlimmer geworden, seit {{Reto|PERSON|2}} weg ist.'
        }
      ]
    )
    addIndexedSession(
      db,
      docs,
      { id: 'bericht', type: 'pdf', title: 'Zuweisung', documentDate: '2026-02-20' },
      [{ text: 'Frau Meier leidet unter Pruefungsangst und Schlafstörungen.' }]
    )
    addIndexedSession(
      db,
      docs,
      { id: 'andere', title: 'Sitzung', createdAt: '2026-04-01T09:00:00.000Z' },
      [{ speaker: 'A', text: 'Heute sprechen wir über den Umzug nach Winterthur.' }]
    )
    indexAll(createIndexService(db, docs))
  }

  it('finds a term regardless of case, umlaut spelling and as part of a longer word (#209 AK 3)', () => {
    seed()
    for (const q of ['prüfungsangst', 'PRUEFUNGSANGST', 'Prüfungs', 'ungsang']) {
      expect(
        search(q)
          .results.map((r) => r.sessionId)
          .sort(),
        q
      ).toEqual(['bericht', 'meier'])
    }
  })

  it('finds text by the original of a pseudonymized name, also by a part of it (#209 AK 4)', () => {
    seed()
    expect(search('Reto').results.map((r) => r.sessionId)).toEqual(['meier'])
    const result = search('andra mei').results.map((r) => r.sessionId)
    expect(result).toEqual(['meier'])
    // Platzhalter stehen nicht im Index
    expect(search('PERSON 2').results).toEqual([])
  })

  it('finds hits in body, title and summary (#209 AK 5) and requires all words in one section', () => {
    seed()
    const title = search('erstgespräch').results
    expect(title.map((r) => r.sessionId)).toEqual(['meier'])
    expect(title[0].hits[0]).toMatchObject({ field: 'title', focus: { kind: 'title' } })
    const summary = search('examen').results[0].hits[0]
    expect(summary).toMatchObject({ field: 'summary', focus: { kind: 'summary' } })
    // «Examen» steht nur in der Zusammenfassung, «Reto» nur im Text
    expect(search('examen reto').results).toEqual([])
    expect(search('umzug winterthur').results.map((r) => r.sessionId)).toEqual(['andere'])
  })

  it('returns each document once with title, date, dossiers and clear-text snippets (#209 AK 7, AK 9)', () => {
    seed()
    db.prepare(
      `INSERT INTO dossiers (id, first_name, last_name, first_name_norm, last_name_norm,
         external_id, external_id_norm, birth_date, created_at, updated_at)
       VALUES ('d1', 'Sandra', 'Meier', 'sandra', 'meier', 'PD-1', 'pd-1', '1990-05-01', 'x', 'x')`
    ).run()
    db.prepare(
      `INSERT INTO session_dossiers (session_id, dossier_id, assigned_at) VALUES ('meier', 'd1', 'x')`
    ).run()
    const result = search('prüfungsangst')
    expect(result.requestId).toBe(7)
    // Ohne Suchprozess (keine Laufzeit): Modell gilt als fehlend
    expect(result.semantic).toBe('model-missing')
    const meier = result.results.find((r) => r.sessionId === 'meier')!
    expect(meier).toMatchObject({
      type: 'audio',
      title: 'Erstgespräch [PERSON 1]',
      titlePlain: 'Erstgespräch Sandra Meier',
      sortDay: '2026-03-04',
      dossiers: [{ id: 'd1', externalId: 'PD-1', birthDate: '1990-05-01' }]
    })
    const body = meier.hits.find((h) => h.field === 'body')!
    expect(body.label).toEqual({ speaker: 'Person B', timestamp: '00:00:12' })
    expect(body.snippet.text).toContain('Reto weg ist')
    expect(markedText(body)).toEqual(['PRÜFUNGSANGST'])
    const bericht = result.results.find((r) => r.sessionId === 'bericht')!
    expect(bericht.sortDay).toBe('2026-02-20')
    expect(bericht.hits[0].label).toEqual({})
  })

  it('points the hit at paragraph and clear-text range of the original (#209 AK 11)', () => {
    seed()
    const hit = search('reto').results[0].hits[0]
    expect(hit.focus).toMatchObject({ kind: 'hit', paraFrom: 0, paraTo: 1, anchor: 'Reto' })
    if (hit.focus.kind !== 'hit') throw new Error('kind')
    const [range] = hit.focus.ranges!
    // Absatz-Klartext ohne Sprecher-/Zeit-Knoten, aber mit den Leerzeichen dazwischen
    const paragraph = '  Die PRÜFUNGSANGST ist schlimmer geworden, seit Reto weg ist.'
    expect(range.p).toBe(1)
    expect(paragraph.slice(range.s, range.e)).toBe('Reto')
  })

  it('marks umlaut variants in the original spelling', () => {
    addIndexedSession(db, docs, { id: 's1' }, [
      { speaker: 'A', text: 'Herr Müller und Herr Mueller kamen.' }
    ])
    indexAll(createIndexService(db, docs))
    const hit = search('MÜLLER').results[0].hits[0]
    expect(markedText(hit)).toEqual(['Müller', 'Mueller'])
  })

  it('reports no hits (#209 AK 10) and excludes unfinished and deleting sessions', () => {
    seed()
    expect(search('Quantenphysik').results).toEqual([])
    insertSession(db, { id: 'proc', status: 'processing', title: 'Prüfungsangst neu' })
    db.prepare(`UPDATE sessions SET deleting_at = 'x' WHERE id = 'bericht'`).run()
    expect(search('prüfungsangst').results.map((r) => r.sessionId)).toEqual(['meier'])
  })

  it('finds queries shorter than 3 characters by scanning, newest first, with a cap', () => {
    seed()
    expect(search('Zu').results.map((r) => r.sessionId)).toEqual(['andere', 'bericht'])
    expect(search('st').results.map((r) => r.sessionId)).toEqual(['meier', 'bericht'])
    // Keine Präfixe im Scan: «sp» stünde sonst in jedem «Sprecher N:»
    expect(search('sp').results.map((r) => r.sessionId)).toEqual(['andere', 'meier'])

    for (let i = 0; i < SEARCH_SHORT_QUERY_MAX_CHUNKS + 5; i++) {
      insertSession(db, { id: `x${i}`, title: `Titel ${i} xy` })
    }
    indexAll(createIndexService(db, docs))
    const capped = search('xy')
    expect(capped.truncated).toBe(true)
  })

  it('restricts a dossier search to its sessions at query time, in the same order (#211 AK 1, AK 3)', () => {
    seed()
    db.prepare(
      `INSERT INTO dossiers (id, first_name, last_name, first_name_norm, last_name_norm, created_at, updated_at)
       VALUES ('d1', 'Sandra', 'Meier', 'sandra', 'meier', 'x', 'x')`
    ).run()
    const all = search('meier').results.map((r) => r.sessionId)
    expect(all).toHaveLength(2)
    expect(search('meier', { kind: 'dossier', dossierId: 'd1' }).results).toEqual([])
    db.prepare(
      `INSERT INTO session_dossiers (session_id, dossier_id, assigned_at) VALUES ('bericht', 'd1', 'x')`
    ).run()
    const scoped = search('meier', { kind: 'dossier', dossierId: 'd1' })
    expect(scoped.results.map((r) => r.sessionId)).toEqual(all.filter((id) => id === 'bericht'))
    expect(scoped.dossiers).toEqual([])
  })
})

describe('SearchService — dossiers (#209 AK 23–25)', () => {
  let db: Database.Database
  let service: SearchService

  beforeEach(() => {
    db = createSearchTestDb()
    service = new SearchService(db)
    const insert = db.prepare(
      `INSERT INTO dossiers (id, first_name, last_name, first_name_norm, last_name_norm,
         external_id, external_id_norm, birth_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'x', 'x')`
    )
    insert.run('d1', 'Anna', 'Müller', 'anna', 'mueller', 'PD-4417', 'pd-4417', '1980-01-02')
    insert.run('d2', 'Anna', 'Müller', 'anna', 'mueller', null, null, '1975-07-08')
    insert.run('d3', 'Jürg', 'Annen', 'juerg', 'annen', 'X-9', 'x-9', null)
  })

  afterEach(() => db.close())

  const ids = (q: string): string[] => service.findDossiers(q).map((d) => d.id)

  it('finds dossiers by parts of first and last name, case and umlaut insensitive', () => {
    expect(ids('mül')).toEqual(['d1', 'd2'])
    expect(ids('ANNA mueller')).toEqual(['d1', 'd2'])
    expect(ids('ann')).toEqual(['d3', 'd1', 'd2'])
    expect(ids('jürg ann')).toEqual(['d3'])
    expect(ids('anna jürg')).toEqual([])
  })

  it('finds dossiers by (a part of) their patient dossier ID', () => {
    expect(ids('pd-44')).toEqual(['d1'])
    expect(ids('4417')).toEqual(['d1'])
    expect(ids('x-9')).toEqual(['d3'])
  })

  it('returns ID and birth date to tell same-named dossiers apart, and comes first in the answer', () => {
    const found = service.query({ requestId: 1, query: 'anna müller', scope: { kind: 'all' } })
    expect(found.dossiers).toEqual([
      {
        id: 'd1',
        firstName: 'Anna',
        lastName: 'Müller',
        externalId: 'PD-4417',
        birthDate: '1980-01-02',
        entryCount: 0
      },
      {
        id: 'd2',
        firstName: 'Anna',
        lastName: 'Müller',
        externalId: null,
        birthDate: '1975-07-08',
        entryCount: 0
      }
    ])
  })

  it('counts assigned entries like the overview, without sessions being deleted', () => {
    insertSession(db, { id: 's1' })
    insertSession(db, { id: 's2', type: 'pdf' })
    insertSession(db, { id: 's3', deletingAt: '2026-01-02T00:00:00.000Z' })
    const assign = db.prepare(
      `INSERT INTO session_dossiers (session_id, dossier_id, assigned_at) VALUES (?, 'd1', 'x')`
    )
    for (const id of ['s1', 's2', 's3']) assign.run(id)
    const found = service.findDossiers('anna müller')
    expect(found.map((d) => [d.id, d.entryCount])).toEqual([
      ['d1', 2],
      ['d2', 0]
    ])
  })
})

describe('SearchService — bounded candidates and dossier filter before the limit (#211 AK 3)', () => {
  let db: Database.Database
  let docs: Map<string, unknown>

  beforeEach(() => {
    db = createSearchTestDb()
    docs = new Map()
    db.prepare(
      `INSERT INTO dossiers (id, first_name, last_name, first_name_norm, last_name_norm, created_at, updated_at)
       VALUES ('d1', 'Lea', 'Muster', 'lea', 'muster', 'x', 'x')`
    ).run()
  })

  afterEach(() => db.close())

  const assign = (ids: string[]): void => {
    const insert = db.prepare(
      `INSERT INTO session_dossiers (session_id, dossier_id, assigned_at) VALUES (?, 'd1', 'x')`
    )
    for (const id of ids) insert.run(id)
  }

  it('gives a dossier the same order as the filtered search over everything, also beyond the limit', () => {
    // 30 Sitzungen, «Angst» unterschiedlich oft → unterschiedliches bm25
    for (let i = 0; i < 30; i++) {
      addIndexedSession(
        db,
        docs,
        {
          id: `s${String(i).padStart(2, '0')}`,
          createdAt: `2026-01-${String(i + 1).padStart(2, '0')}T08:00:00.000Z`
        },
        [{ speaker: 'A', text: `${'Angst '.repeat((i % 7) + 1)}und noch ${i} Wörter zum Füllen.` }]
      )
    }
    indexAll(createIndexService(db, docs))
    const inDossier = ['s03', 's11', 's17', 's22', 's29']
    assign(inDossier)
    const ids = (service: SearchService, scope: SearchScope): string[] =>
      service.query({ requestId: 1, query: 'angst', scope }).results.map((r) => r.sessionId)

    const unlimited = new SearchService(db)
    const limited = new SearchService(db, { maxCandidates: 10 })
    const expected = ids(unlimited, { kind: 'all' }).filter((id) => inDossier.includes(id))
    expect(expected).toHaveLength(5)
    // Unterhalb der Grenze (5 Abschnitte im Dossier ≤ 10): genau die gefilterte Gesamtsuche
    expect(ids(limited, { kind: 'dossier', dossierId: 'd1' })).toEqual(expected)
    // Die Gesamtsuche greift an der Grenze ab und meldet das
    const global = limited.query({ requestId: 1, query: 'angst', scope: { kind: 'all' } })
    expect(global.truncated).toBe(true)
    expect(global.results).toHaveLength(10)
    // Was die begrenzte Gesamtsuche aus dem Dossier zeigt, steht in derselben Reihenfolge
    const common = global.results.map((r) => r.sessionId).filter((id) => inDossier.includes(id))
    expect(expected.filter((id) => common.includes(id))).toEqual(common)
  })

  it('finds short queries in a dossier even if its sessions are older than the scan window (review #222)', () => {
    for (let i = 0; i < 600; i++) {
      insertSession(db, {
        id: `x${String(i).padStart(3, '0')}`,
        title: `Titel ab ${i}`,
        createdAt: new Date(Date.UTC(2024, 0, 1) + i * 3_600_000).toISOString()
      })
    }
    indexAll(createIndexService(db, docs))
    assign(['x000', 'x001', 'x002'])
    const service = new SearchService(db)
    const scoped = service.query({
      requestId: 1,
      query: 'ab',
      scope: { kind: 'dossier', dossierId: 'd1' }
    })
    expect(scoped.results.map((r) => r.sessionId).sort()).toEqual(['x000', 'x001', 'x002'])
    expect(scoped.truncated).toBe(false)
    const global = service.query({ requestId: 1, query: 'ab', scope: { kind: 'all' } })
    expect(global.truncated).toBe(true)
  })
})
