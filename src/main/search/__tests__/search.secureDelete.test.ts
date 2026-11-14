import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// #209 Postcondition 1: Nach dem Löschen einer Sitzung stehen ihre Daten für
// die Suche weder in der Datenbankdatei noch im WAL — auch nicht als
// Löschvermerk mit den Trigrammen im FTS-Index (Bauplan Befund 6). Echte
// Datei-DB, echter Löschpfad, Suche in den Rohbytes. PC 3/4: dasselbe für die
// letzten Suchanfragen.

const home = vi.hoisted(() => ({ path: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => home.path },
  BrowserWindow: { getAllWindows: () => [] }
}))

import { initDatabase, getDatabase, closeDatabase } from '../../db/connection'
import { SessionService } from '../../services/SessionService'
import { DossierService } from '../../services/DossierService'
import { SearchIndexService } from '../SearchIndexService'
import { SearchService } from '../SearchService'
import { SearchRecentRepository } from '../../db/repositories/SearchRecentRepository'
import { normalizeSearchText } from '../../../shared/utils/search-normalize'
import { makeDoc } from './helpers'

// Seltene Buchstabenfolgen: ihre Trigramme kommen sonst nirgends vor
const TEXT_MARKER = 'Qxzäjvyk'
const CHIP_MARKER = 'Wqxzöpfj'
const TITLE_MARKER = 'Zyqxüvbk'
const MARKERS = [TEXT_MARKER, CHIP_MARKER, TITLE_MARKER]

function trigrams(marker: string): string[] {
  const norm = normalizeSearchText(marker)
  const out = new Set<string>()
  for (let i = 0; i + 3 <= norm.length; i++) out.add(norm.slice(i, i + 3))
  return [...out]
}

/** Alle Nadeln: Marker, normalisierte Form und jedes Trigramm. */
const NEEDLES = MARKERS.flatMap((m) => [m, normalizeSearchText(m), ...trigrams(m)])

function filesContaining(dbPath: string, needles: string[]): string[] {
  const found: string[] = []
  for (const file of [dbPath, `${dbPath}-wal`]) {
    if (!existsSync(file)) continue
    const bytes = readFileSync(file)
    for (const needle of needles) {
      if (bytes.includes(Buffer.from(needle, 'utf-8'))) found.push(`${file}: ${needle}`)
    }
  }
  return found
}

/** Trigramme der Marker in den FTS-Blöcken (Schattentabelle search_fts_data). */
function trigramsInFtsData(): string[] {
  const blocks = getDatabase().prepare('SELECT block FROM search_fts_data').all() as Array<{
    block: Buffer
  }>
  const found = new Set<string>()
  for (const { block } of blocks) {
    for (const marker of MARKERS) {
      for (const t of trigrams(marker)) if (block.includes(Buffer.from(t, 'utf-8'))) found.add(t)
    }
  }
  return [...found]
}

describe('search index — nothing recoverable after deletion (#209 PC 1)', () => {
  let dbPath: string
  let dataDir: string

  beforeEach(() => {
    home.path = mkdtempSync(join(tmpdir(), 'search-secure-delete-'))
    dataDir = join(home.path, '.therascript')
    dbPath = join(home.path, 'therascript.db')
    initDatabase(dbPath)
  })

  afterEach(() => {
    closeDatabase()
    rmSync(home.path, { recursive: true, force: true })
  })

  function indexedSession(): string {
    const sessions = new SessionService(getDatabase())
    const session = sessions.createSession(`Sitzung ${TITLE_MARKER}`, 'audio')
    const anonymizedPath = join(dataDir, 'anonymized', `${session.id}.json`)
    writeFileSync(
      anonymizedPath,
      JSON.stringify(
        makeDoc([
          { speaker: 'A', text: `Wir sprachen über ${TEXT_MARKER} und Schlaf.` },
          { speaker: 'B', text: `Mit {{${CHIP_MARKER}|PERSON|1}} war ich unterwegs.` }
        ])
      )
    )
    sessions.updateSession(session.id, { status: 'queued' })
    sessions.updateSession(session.id, { status: 'processing' })
    sessions.updateSession(session.id, { anonymizedPath, status: 'review' })
    // Ruhiges Fenster überspringen: «jetzt» liegt eine Minute in der Zukunft
    const indexer = new SearchIndexService(getDatabase(), { now: () => Date.now() + 60_000 })
    expect(indexer.runTextPhase().indexed).toBe(1)

    const search = new SearchService(getDatabase())
    for (const marker of MARKERS) {
      const ids = search
        .query({ requestId: 1, query: marker, scope: { kind: 'all' } })
        .results.map((r) => r.sessionId)
      expect(ids, marker).toEqual([session.id])
    }
    // Schwerer Fall: Inhalt in der Datei UND im WAL
    getDatabase().pragma('wal_checkpoint(TRUNCATE)')
    getDatabase().prepare('UPDATE sessions SET title = title WHERE id = ?').run(session.id)
    expect(trigramsInFtsData().length).toBeGreaterThan(0)
    expect(filesContaining(dbPath, NEEDLES).length).toBeGreaterThan(0)
    return session.id
  }

  it('SessionService.deleteSession leaves no marker, normalized form or trigram in .db or -wal', () => {
    const id = indexedSession()
    expect(new SessionService(getDatabase()).deleteSession(id)).toBe(true)
    expect(getDatabase().prepare('SELECT COUNT(*) AS n FROM search_chunks').get()).toEqual({
      n: 0
    })
    expect(trigramsInFtsData()).toEqual([])
    expect(filesContaining(dbPath, NEEDLES)).toEqual([])
  })

  it('DossierService.deleteDossier leaves nothing either, also no recent query naming the dossier', () => {
    const id = indexedSession()
    const dossiers = new DossierService(getDatabase())
    const created = dossiers.create({
      firstName: 'Kxqvan',
      lastName: 'Zxqbert',
      externalId: 'PD-QX81'
    })
    if (!created.ok) throw new Error('create')
    getDatabase()
      .prepare(
        'INSERT INTO session_dossiers (session_id, dossier_id, assigned_at) VALUES (?, ?, ?)'
      )
      .run(id, created.dossier.id, new Date().toISOString())
    const recent = new SearchRecentRepository(getDatabase())
    recent.remember('Kxqvan Schlaf')
    recent.remember('pd-qx81')
    recent.remember('Zxqbert')
    const queryNeedles = ['Kxqvan Schlaf', 'kxqvan schlaf', 'pd-qx81', 'Zxqbert', 'zxqbert']
    expect(filesContaining(dbPath, queryNeedles).length).toBeGreaterThan(0)

    const { fingerprint } = dossiers.deletePreview(created.dossier.id)!
    expect(dossiers.deleteDossier(created.dossier.id, fingerprint)).toMatchObject({
      ok: true,
      deletedSessionIds: [id],
      incomplete: false
    })
    expect(trigramsInFtsData()).toEqual([])
    expect(filesContaining(dbPath, NEEDLES)).toEqual([])
    expect(filesContaining(dbPath, queryNeedles)).toEqual([])
    expect(recent.list()).toEqual([])
  })

  it('counter-check: without the secure-delete option the trigrams stay in the FTS blocks', () => {
    // Belegt, dass die Prüfung oben ein fehlendes 'secure-delete' bemerkt
    getDatabase()
      .prepare(`INSERT INTO search_fts(search_fts, rank) VALUES ('secure-delete', 0)`)
      .run()
    const id = indexedSession()
    expect(new SessionService(getDatabase()).deleteSession(id)).toBe(true)
    expect(trigramsInFtsData().length).toBeGreaterThan(0)
    expect(filesContaining(dbPath, NEEDLES).length).toBeGreaterThan(0)
  })

  it('clearing the recent queries leaves nothing in .db or -wal (#209 PC 3)', () => {
    const recent = new SearchRecentRepository(getDatabase())
    recent.remember('Qvxzlrm Geheimanfrage')
    getDatabase().pragma('wal_checkpoint(TRUNCATE)')
    recent.remember('Qvxzlrm Zweite')
    expect(filesContaining(dbPath, ['Qvxzlrm']).length).toBeGreaterThan(0)
    recent.clear()
    expect(filesContaining(dbPath, ['Qvxzlrm', 'qvxzlrm'])).toEqual([])
  })
})
