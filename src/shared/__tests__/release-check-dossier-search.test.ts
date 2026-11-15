import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { normalizeSearchText } from '../utils/search-normalize'
import { SEARCH_MODEL_DIR_NAME } from '../model-catalog'

// Release-Prüfung, Epic #192 (scripts/release-check/lib/dossier-search.mjs):
// die reinen Teile — Seed-Erwartungen, Vergleich, Auswertung der Suche und des
// Löschens. Der Lauf selbst braucht eine gepackte App und die DMG der
// Vorversion und ist hier nicht abgedeckt.

const LIB = join(__dirname, '../../../scripts/release-check/lib')

/* eslint-disable @typescript-eslint/no-explicit-any */
let m: any

beforeAll(async () => {
  // Pfad als Variable: das .mjs hat keine Typen, TypeScript soll es nicht auflösen
  const url = pathToFileURL(join(LIB, 'dossier-search.mjs')).href
  m = await import(/* @vite-ignore */ url)
})

const DOSSIER = {
  id: 'd-1',
  firstName: 'Daniel',
  lastName: 'Brunner',
  externalId: 'RC-SEED-001',
  birthDate: '1981-06-14',
  diagnoses: '',
  medication: '',
  note: '',
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:01.000Z'
}

function rawSeed(overrides: Record<string, unknown> = {}): any {
  return {
    dossier: DOSSIER,
    audioId: 's-audio',
    pdfId: 's-pdf',
    assignments: [
      { session_id: 's-audio', dossier_id: 'd-1', assigned_at: '2026-11-01T10:00:02.000Z' },
      { session_id: 's-pdf', dossier_id: 'd-1', assigned_at: '2026-11-01T10:00:03.000Z' }
    ],
    documentDates: { 's-pdf': '2024-03-15' },
    recentQueries: [{ query: 'Schlaftagebuch', usedAt: '2026-11-01T10:00:04.000Z' }],
    recentItems: [
      { dossier_id: null, session_id: 's-error' },
      { dossier_id: 'd-1', session_id: null },
      { dossier_id: null, session_id: 's-audio' }
    ],
    ...overrides
  }
}

describe('Seed: Erkennung der Vorversion', () => {
  it('legt den Dossier-Teil nur an, wenn die App alle nötigen Schnittstellen hat', () => {
    const all = { dossiers: true, search: true, recent: true, documentDate: true }
    expect(m.supportsDossierSeed(all)).toBe(true)
    for (const key of Object.keys(all)) {
      expect(m.supportsDossierSeed({ ...all, [key]: false })).toBe(false)
    }
    // Vorversion vor Epic #192: keine der Schnittstellen
    expect(m.supportsDossierSeed({})).toBe(false)
    expect(m.supportsDossierSeed(undefined)).toBe(false)
  })

  it('der Erkennungs-Ausdruck läuft gegen eine App ohne Dossiers, ohne zu werfen', () => {
    const evaluate = (api: unknown): unknown =>
      new Function('window', `return ${m.FEATURES_EXPRESSION}`)({ api })
    expect(evaluate({ sessions: {} })).toEqual({
      dossiers: false,
      search: false,
      recent: false,
      documentDate: false
    })
    expect(
      evaluate({
        sessions: { setDocumentDate: () => {} },
        dossiers: {},
        search: {},
        recent: {}
      })
    ).toEqual({ dossiers: true, search: true, recent: true, documentDate: true })
  })
})

describe('Seed: Erwartungen für künftige Releases', () => {
  it('hält Dossier, Zuordnungen, Dokumentdatum, Suchanfrage und «Zuletzt» fest', () => {
    const expected = m.buildDossierSeedExpectations(rawSeed())
    expect(expected.dossier).toEqual(DOSSIER)
    expect(expected.assignments).toEqual([
      's-audio|d-1|2026-11-01T10:00:02.000Z',
      's-pdf|d-1|2026-11-01T10:00:03.000Z'
    ])
    expect(expected.documentDates).toEqual({ 's-pdf': '2024-03-15' })
    expect(expected.recentQueries).toEqual([
      { query: 'Schlaftagebuch', usedAt: '2026-11-01T10:00:04.000Z' }
    ])
    expect(expected.recentItems).toEqual(['session:s-error', 'dossier:d-1', 'session:s-audio'])
  })

  it.each([
    ['Dossier fehlt', { dossier: null }, /Dossier wurde nicht angelegt/],
    ['falsche Angabe', { dossier: { ...DOSSIER, birthDate: null } }, /birthDate/],
    [
      'Zuordnung fehlt',
      {
        assignments: [
          { session_id: 's-audio', dossier_id: 'd-1', assigned_at: '2026-11-01T10:00:02.000Z' }
        ]
      },
      /s-pdf ist dem Dossier nicht zugeordnet/
    ],
    ['Dokumentdatum fehlt', { documentDates: {} }, /Dokumentdatum/],
    ['Suchanfrage fehlt', { recentQueries: [] }, /Suchanfrage/],
    [
      'Dossier nicht in «Zuletzt»',
      { recentItems: [{ dossier_id: null, session_id: 's-audio' }] },
      /Zuletzt/
    ]
  ])('bricht den Seed-Aufbau ab, wenn etwas fehlt: %s', (_label, overrides, message) => {
    expect(() => m.buildDossierSeedExpectations(rawSeed(overrides))).toThrow(message)
  })
})

describe('Prüfung: Dossier-Teil des Seeds erhalten', () => {
  const actualFrom = (raw: any): any => ({
    dossier: raw.dossier,
    assignments: raw.assignments,
    documentDates: raw.documentDates,
    recentQueries: raw.recentQueries,
    recentItems: raw.recentItems
  })

  it('alles unverändert (auch mit neuen Einträgen daneben): alle grün', () => {
    const expected = m.buildDossierSeedExpectations(rawSeed())
    const actual = actualFrom(rawSeed())
    actual.assignments = [
      ...actual.assignments,
      { session_id: 's-neu', dossier_id: 'd-2', assigned_at: '2026-11-15T08:00:00.000Z' }
    ]
    actual.recentItems = [{ dossier_id: 'd-2', session_id: null }, ...actual.recentItems]
    actual.recentQueries = [{ query: 'neu', usedAt: '2026-11-15T08:00:00.000Z' }]
    actual.recentQueries.push(...rawSeed().recentQueries)
    const results = m.compareDossierSeed(expected, actual)
    expect(results).toHaveLength(5)
    expect(results.filter((r: any) => r.error)).toEqual([])
  })

  it.each([
    ['Dossier fehlt', (a: any) => (a.dossier = null), 'Patientendossier', /Dossier fehlt/],
    [
      'Angabe geändert',
      (a: any) => (a.dossier = { ...a.dossier, externalId: 'X' }),
      'Patientendossier',
      /externalId/
    ],
    ['Zuordnung weg', (a: any) => a.assignments.pop(), 'Zuordnungen', /s-pdf\|d-1/],
    [
      'Zuordnungszeit geändert',
      (a: any) => (a.assignments[0] = { ...a.assignments[0], assigned_at: 'x' }),
      'Zuordnungen',
      /s-audio\|d-1/
    ],
    ['Dokumentdatum weg', (a: any) => (a.documentDates = {}), 'Dokumentdatum', /2024-03-15/],
    ['Suchanfrage weg', (a: any) => (a.recentQueries = []), 'Suchanfragen', /Schlaftagebuch/],
    [
      '«Zuletzt»-Reihenfolge vertauscht',
      (a: any) => a.recentItems.reverse(),
      'Zuletzt',
      /Reihenfolge/
    ],
    ['«Zuletzt» leer', (a: any) => (a.recentItems = []), 'Zuletzt', /keine/]
  ])('meldet rot: %s', (_label, mutate, check, message) => {
    const expected = m.buildDossierSeedExpectations(rawSeed())
    const actual = actualFrom(rawSeed())
    mutate(actual)
    const results = m.compareDossierSeed(expected, actual)
    const failed = results.filter((r: any) => r.error)
    expect(failed).toHaveLength(1)
    expect(failed[0].name).toContain(check)
    expect(failed[0].error).toMatch(message)
  })
})

describe('Prüfung: Suche über den Bestand', () => {
  const result = (docs: Array<{ id: string; kinds: string[] }>, semantic = 'complete'): any => ({
    requestId: 1,
    dossiers: [],
    truncated: false,
    semantic,
    results: docs.map((d) => ({ sessionId: d.id, hits: d.kinds.map((kind) => ({ kind })) }))
  })
  const ready = { model: { status: 'ready' }, semantic: 'ready' }

  it('exakt: meldet die Sitzungen, die fehlen', () => {
    const r = result([{ id: 'a', kinds: ['exact'] }])
    expect(m.missingInResults(r, ['a'])).toEqual([])
    expect(m.missingInResults(r, ['a', 'b'])).toEqual(['b'])
    expect(m.missingInResults(null, ['a'])).toEqual(['a'])
  })

  it('Suchmodell fehlt auf dem Datenträger: nicht geprüft, nie grün und nie rot', () => {
    // Was der Status meldet, spielt dann keine Rolle
    for (const availability of [null, ready, { model: { status: 'unpublished' } }]) {
      const verdict = m.evaluateSearchModel({ installed: false, availability })
      expect(verdict.state).toBe('skipped')
      const entry = m.skipped('Suche nach Bedeutung', verdict.detail)
      expect(m.marker(entry)).toBe('–')
      expect(m.summarize([entry]).passed).toEqual([])
      expect(m.summarize([entry]).failed).toEqual([])
    }
  })

  it.each([
    [{ status: 'waiting', reason: 'starting' }],
    [{ status: 'waiting', reason: 'busy', nextAttemptAt: 'x' }],
    [{ status: 'downloading', progress: 40 }],
    [{ status: 'failed', reason: 'extract' }],
    [{ status: 'retry-scheduled', reason: 'checksum', nextAttemptAt: 'x' }],
    [{ status: 'unpublished' }]
  ])(
    'Suchmodell liegt auf dem Datenträger, Status %o: weiter abfragen (nach der Frist rot), nie «nicht geprüft»',
    (model) => {
      const verdict = m.evaluateSearchModel({
        installed: true,
        availability: { model, semantic: 'model-missing' }
      })
      expect(verdict.state).toBe('waiting')
      expect(verdict.detail).toContain(model.status)
    }
  )

  it('Suchmodell: bereit ist grün, noch nicht gefragt heisst warten, blockiertes Werkzeug rot', () => {
    expect(m.evaluateSearchModel({ installed: true, availability: ready }).state).toBe('ok')
    expect(m.evaluateSearchModel({ installed: true, availability: null }).state).toBe('waiting')
    expect(
      m.evaluateSearchModel({
        installed: true,
        availability: { ...ready, semantic: 'tool-blocked', semanticMessage: 'blockiert' }
      })
    ).toEqual({ state: 'fail', detail: 'blockiert' })
  })

  it('Ordner des Suchmodells kommt aus dem Katalog dieses Checkouts', () => {
    const catalog = readFileSync(join(__dirname, '../model-catalog.ts'), 'utf8')
    expect(m.searchModelDirFromCatalog(catalog)).toBe(SEARCH_MODEL_DIR_NAME)
    expect(() => m.searchModelDirFromCatalog('kein Katalog')).toThrow(/SEARCH_MODEL_DIR_NAME/)
  })

  it('nach Bedeutung: grün nur mit einem Treffer nach Bedeutung in der Sitzung', () => {
    const ok = m.evaluateSemantic({
      result: result([{ id: 'a', kinds: ['exact', 'semantic'] }]),
      sessionId: 'a'
    })
    expect(ok.state).toBe('ok')
    // Nur exakt getroffen: die Vektoren könnten noch fehlen — weiter warten
    expect(
      m.evaluateSemantic({ result: result([{ id: 'a', kinds: ['exact'] }]), sessionId: 'a' }).state
    ).toBe('waiting')
    expect(
      m.evaluateSemantic({ result: result([{ id: 'b', kinds: ['semantic'] }]), sessionId: 'a' })
        .state
    ).toBe('waiting')
    expect(m.evaluateSemantic({ result: null, sessionId: 'a' }).state).toBe('waiting')
  })

  it.each(['pending', 'unavailable-processing', 'error', 'superseded', 'model-missing'])(
    'nach Bedeutung: Antwort «%s» heisst weiter warten',
    (semantic) => {
      expect(
        m.evaluateSemantic({
          result: result([{ id: 'a', kinds: ['semantic'] }], semantic),
          sessionId: 'a'
        }).state
      ).toBe('waiting')
    }
  )

  it('nach Bedeutung: blockiertes Werkzeug ist rot', () => {
    expect(m.evaluateSemantic({ result: result([], 'tool-blocked'), sessionId: 'a' }).state).toBe(
      'fail'
    )
  })

  it('die Suchbegriffe passen zu den Testdaten und zum Seed', () => {
    const fixtures = readFileSync(join(LIB, '../build-fixtures.mjs'), 'utf8')
    const seed = readFileSync(join(LIB, 'seed.mjs'), 'utf8')
    const pdfProbe = m.EXACT_PROBES.find((p: any) => p.seed === 'pdf')
    const audioProbe = m.EXACT_PROBES.find((p: any) => p.seed === 'audio')
    expect(fixtures).toContain(`<h1>${pdfProbe.query}</h1>`)
    // editDocument hängt « Im Seed ergänzt.» an den ersten Text
    expect(seed).toContain(`${audioProbe.query}.`)

    // Die exakte Suche verlangt jedes Wort (≥ 3 Zeichen) als Teilwort; die
    // Umschreibung enthält Wörter, die im PDF nicht vorkommen — ein Treffer
    // kann also nur aus den Vektoren kommen
    const pdfText = normalizeSearchText(
      fixtures.slice(fixtures.indexOf('const TEXT_PAGE'), fixtures.indexOf('function wavHeader'))
    )
    const words = normalizeSearchText(m.SEMANTIC_PROBE)
      .split(/\s+/)
      .filter((w) => w.length >= 3)
    const absent = words.filter((w) => !pdfText.includes(w))
    expect(absent.length).toBeGreaterThanOrEqual(2)
  })
})

describe('Prüfung: Dossier samt exklusiver Sitzung gelöscht', () => {
  const empty = {
    listedSessionIds: ['andere'],
    dossierSearch: { dossiers: [], results: [] },
    contentSearch: { dossiers: [], results: [{ sessionId: 'andere' }] },
    dbCounts: { sessions: 0, dossiers: 0, session_dossiers: 0, search_chunks: 0 }
  }

  it('nichts mehr auffindbar: leer', () => {
    expect(m.leftoversAfterDossierDelete({ dossierId: 'd', sessionId: 's', state: empty })).toEqual(
      []
    )
  })

  it('meldet jeden Rest einzeln', () => {
    const left = m.leftoversAfterDossierDelete({
      dossierId: 'd',
      sessionId: 's',
      state: {
        listedSessionIds: ['s'],
        dossierSearch: { dossiers: [{ id: 'd' }], results: [{ sessionId: 's' }] },
        contentSearch: { dossiers: [], results: [{ sessionId: 's' }] },
        dbCounts: { sessions: 0, search_chunks: 3, session_dossiers: 1 }
      }
    })
    expect(left).toEqual([
      'Sitzung in der Liste',
      'Dossier in der Suche',
      'Sitzung in der Suche nach dem Dossiernamen',
      'Sitzung in der Suche nach ihrem Inhalt',
      '3 Zeile(n) in search_chunks',
      '1 Zeile(n) in session_dossiers'
    ])
  })

  it('SQL nur mit unverdächtigen IDs, deckt alle abgeleiteten Tabellen ab', () => {
    const sql = m.leftoverQueries('d-1', 'abc-2')
    expect(Object.keys(sql).sort()).toEqual([
      'dossiers',
      'recent_items',
      'search_chunks',
      'search_index_state',
      'session_dossiers',
      'sessions'
    ])
    expect(() => m.leftoverQueries("d'; DROP TABLE x; --", 's')).toThrow(/Unerwartete ID/)
  })
})

describe('Bericht', () => {
  it('trennt grün, rot und nicht geprüft', () => {
    const results = [
      { name: 'a', ok: true },
      { name: 'b', ok: false, detail: 'x' },
      m.skipped('c', 'Suchmodell nicht installiert')
    ]
    const { passed, failed, notChecked } = m.summarize(results)
    expect(passed.map((r: any) => r.name)).toEqual(['a'])
    expect(failed.map((r: any) => r.name)).toEqual(['b'])
    expect(notChecked.map((r: any) => r.name)).toEqual(['c'])
    expect(results.map(m.marker)).toEqual(['✓', '✗', '–'])
  })
})
