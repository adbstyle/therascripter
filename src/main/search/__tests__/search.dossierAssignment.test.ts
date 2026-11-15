import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// #205 × #209 — Zuordnen, Lösen und Dokumentdatum lösen keine Neuindexierung
// aus (die Suche liest Zuordnungen erst bei der Abfrage), und eine gelöschte,
// zugeordnete und indexierte Sitzung hinterlässt weder Zuordnung noch
// Indexzeilen noch Dokumentdatum — auch über das gestaffelte Löschen der Suche.

const home = vi.hoisted(() => ({ path: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => home.path },
  BrowserWindow: { getAllWindows: () => [] }
}))

import { initDatabase, getDatabase, closeDatabase } from '../../db/connection'
import { SessionService } from '../../services/SessionService'
import { SessionDossierService } from '../../services/SessionDossierService'
import { DossierService } from '../../services/DossierService'
import {
  SearchIndexService,
  initSearchIndexService,
  resetSearchIndexServiceForTests
} from '../SearchIndexService'
import { makeDoc } from './helpers'

describe('dossier assignment and the search index (#205, #209)', () => {
  let indexer: SearchIndexService
  let dataDir: string

  beforeEach(() => {
    home.path = mkdtempSync(join(tmpdir(), 'search-dossier-'))
    dataDir = join(home.path, '.therascript')
    initDatabase(join(home.path, 'therascript.db'))
    indexer = initSearchIndexService(getDatabase(), {
      // Ruhiges Fenster überspringen: «jetzt» liegt eine Minute in der Zukunft
      now: () => Date.now() + 60_000,
      finishDeletion: (id) => {
        new SessionService(getDatabase()).finishDeletion(id)
      }
    })
    indexer.start()
  })

  afterEach(() => {
    resetSearchIndexServiceForTests()
    closeDatabase()
    rmSync(home.path, { recursive: true, force: true })
  })

  function indexedPdfInDossier(): { sessionId: string; dossierId: string } {
    const sessions = new SessionService(getDatabase())
    const session = sessions.createSession('Austrittsbericht', 'pdf')
    const anonymizedPath = join(dataDir, 'anonymized', `${session.id}.json`)
    writeFileSync(anonymizedPath, JSON.stringify(makeDoc([{ text: 'Schlafprobleme seit Mai.' }])))
    sessions.updateSession(session.id, { status: 'processing' })
    sessions.updateSession(session.id, { anonymizedPath, status: 'review' })
    expect(indexer.runTextPhase().indexed).toBe(1)

    const created = new DossierService(getDatabase()).create({
      firstName: 'Lukas',
      lastName: 'Hofer'
    })
    if (!created.ok) throw new Error('create')
    return { sessionId: session.id, dossierId: created.dossier.id }
  }

  function count(sql: string, id: string): number {
    return (getDatabase().prepare(sql).get(id) as { n: number }).n
  }

  function searchRev(id: string): number {
    return (
      getDatabase().prepare('SELECT search_rev FROM sessions WHERE id = ?').get(id) as {
        search_rev: number
      }
    ).search_rev
  }

  it('assign, unassign and document date neither raise search_rev nor trigger re-indexing', () => {
    const { sessionId, dossierId } = indexedPdfInDossier()
    const rev = searchRev(sessionId)
    const assignments = new SessionDossierService(getDatabase())

    expect(assignments.assign(sessionId, dossierId)).toEqual({ ok: true })
    expect(new SessionService(getDatabase()).setDocumentDate(sessionId, '2024-03-01')).toEqual({
      ok: true
    })
    expect(assignments.unassign(sessionId, dossierId)).toEqual({ ok: true })
    expect(assignments.assign(sessionId, dossierId)).toEqual({ ok: true })

    expect(searchRev(sessionId)).toBe(rev)
    expect(indexer.runTextPhase().indexed).toBe(0)
  })

  it('deleting an assigned, indexed PDF leaves no assignment, no index rows, no document date', () => {
    const { sessionId, dossierId } = indexedPdfInDossier()
    new SessionDossierService(getDatabase()).assign(sessionId, dossierId)
    new SessionService(getDatabase()).setDocumentDate(sessionId, '2024-03-01')
    expect(
      count('SELECT COUNT(*) AS n FROM search_chunks WHERE session_id = ?', sessionId)
    ).toBeGreaterThan(0)

    expect(new SessionService(getDatabase()).deleteSession(sessionId)).toBe(true)
    // Gestaffeltes Löschen läuft noch: Zeile markiert, Zuordnung und Datum schon weg
    expect(
      getDatabase().prepare('SELECT document_date FROM sessions WHERE id = ?').get(sessionId)
    ).toEqual({ document_date: null })
    expect(
      count('SELECT COUNT(*) AS n FROM session_dossiers WHERE session_id = ?', sessionId)
    ).toBe(0)
    expect(new SessionDossierService(getDatabase()).timeline(dossierId)).toEqual([])

    indexer.drain()
    expect(count('SELECT COUNT(*) AS n FROM sessions WHERE id = ?', sessionId)).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM search_chunks WHERE session_id = ?', sessionId)).toBe(0)
    expect(
      count('SELECT COUNT(*) AS n FROM session_dossiers WHERE session_id = ?', sessionId)
    ).toBe(0)
  })
})
