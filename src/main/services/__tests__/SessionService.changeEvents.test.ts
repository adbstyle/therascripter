import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { SessionService } from '../SessionService'
import { applyTestSchema } from '../../db/__tests__/test-utils'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/home')
  }
}))

const notifySessionsChanged = vi.fn()
vi.mock('../ChangeEvents', () => ({
  notifySessionsChanged: (...args: unknown[]) => notifySessionsChanged(...args)
}))

/** Epic #192 — jede für Listen sichtbare Änderung meldet `sessions:changed`. */
describe('SessionService → sessions:changed', () => {
  let db: Database.Database
  let service: SessionService

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    applyTestSchema(db)
    service = new SessionService(db)
    notifySessionsChanged.mockReset()
  })

  afterEach(() => {
    db.close()
  })

  it('beim Anlegen', () => {
    service.createSession('Arztbericht', 'pdf')
    expect(notifySessionsChanged).toHaveBeenCalledTimes(1)
  })

  it('bei Status, Titel und Zusammenfassung', () => {
    const session = service.createSession('Arztbericht', 'pdf')
    notifySessionsChanged.mockReset()

    service.updateSession(session.id, { status: 'processing' })
    service.renameSession(session.id, 'Neuer Titel')
    service.saveGeneratedSummary(session.id, 'Titel', 'Text', 'gemma')
    service.updateSummaryText(session.id, 'Bearbeitet')
    service.updateTitle(session.id, 'Von Hand')
    expect(notifySessionsChanged).toHaveBeenCalledTimes(5)
  })

  it('nicht bei reinen Dateipfaden', () => {
    const session = service.createSession('Arztbericht', 'pdf')
    notifySessionsChanged.mockReset()
    service.updateSession(session.id, { transcriptPath: '/t.json', extractedPath: '/e.json' })
    expect(notifySessionsChanged).not.toHaveBeenCalled()
  })

  it('beim Löschen mit der gelöschten ID', () => {
    const session = service.createSession('Arztbericht', 'pdf')
    notifySessionsChanged.mockReset()
    expect(service.deleteSession(session.id)).toBe(true)
    expect(notifySessionsChanged).toHaveBeenCalledWith([session.id])
  })

  it('nicht im Dossier-Löschpfad — DossierService meldet die IDs dort selbst (kein Doppel)', () => {
    const session = service.createSession('Arztbericht', 'pdf')
    notifySessionsChanged.mockReset()
    service.markForDeletion([session.id])
    expect(service.finishDeletion(session.id)).toBe(true)
    expect(notifySessionsChanged).not.toHaveBeenCalled()
  })

  it('nicht für eine unbekannte Sitzung', () => {
    expect(service.deleteSession('gibt-es-nicht')).toBe(false)
    expect(service.renameSession('gibt-es-nicht', 'x')).toBeNull()
    expect(notifySessionsChanged).not.toHaveBeenCalled()
  })
})
