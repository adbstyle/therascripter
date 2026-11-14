import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * #213 — «Zuletzt geöffnet» im Main-Prozess:
 * - AK 1: höchstens acht Einträge, Dossiers und Sitzungen gemischt
 * - AK 2: das zuletzt geöffnete zuerst, eine laufende Aufnahme vor allen
 * - PC 1: übersteht einen Neustart (SQLite)
 * - PC 2: Gelöschtes verschwindet sofort und ist in den Dateien nicht mehr
 *   auffindbar — Dossier, Sitzung, auch während ihr Löschen noch läuft
 */

const home = vi.hoisted(() => ({ path: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => home.path },
  BrowserWindow: { getAllWindows: () => [] }
}))
const recentEvents = vi.hoisted(() => ({ count: 0 }))
vi.mock('../ChangeEvents', () => ({
  notifySessionsChanged: vi.fn(),
  notifyDossiersChanged: vi.fn(),
  notifyRecentChanged: () => {
    recentEvents.count++
  }
}))

import { RecentService } from '../RecentService'
import { DossierService } from '../DossierService'
import { SessionService } from '../SessionService'
import { RECENT_LIMIT } from '../../db/repositories/RecentRepository'
import { applyTestSchema } from '../../db/__tests__/test-utils'
import { initDatabase, getDatabase, closeDatabase } from '../../db/connection'
import type { RecentEntry } from '../../../shared/types/Recent'

function keys(entries: RecentEntry[]): string[] {
  return entries.map((e) =>
    e.kind === 'dossier' ? `d:${e.dossier.lastName}` : `s:${e.session.title}`
  )
}

function fileContains(path: string, needle: string): boolean {
  if (!existsSync(path)) return false
  return readFileSync(path).includes(Buffer.from(needle, 'utf-8'))
}

describe('RecentService (#213)', () => {
  let db: Database.Database
  let recent: RecentService
  let dossiers: DossierService
  let sessions: SessionService
  let activeSessionId: string | null
  let clock: number

  function dossier(lastName: string): string {
    const r = dossiers.create({ firstName: 'Anna', lastName })
    if (!r.ok) throw new Error('create failed')
    return r.dossier.id
  }

  function touch(kind: 'dossier' | 'session', id: string): void {
    clock += 1000
    recent.touch({ kind, id }, new Date(clock))
  }

  beforeEach(() => {
    home.path = mkdtempSync(join(tmpdir(), 'recent-service-test-'))
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    applyTestSchema(db)
    activeSessionId = null
    recent = new RecentService(db, { getActiveSessionId: () => activeSessionId })
    dossiers = new DossierService(db)
    sessions = new SessionService(db)
    clock = Date.parse('2026-11-14T08:00:00.000Z')
    recentEvents.count = 0
  })

  afterEach(() => {
    vi.restoreAllMocks()
    db.close()
    rmSync(home.path, { recursive: true, force: true })
  })

  it('zeigt Dossiers, Sitzungen und PDFs gemischt, das zuletzt geöffnete zuerst (AK 1/2)', () => {
    const hofer = dossier('Hofer')
    const audio = sessions.createSession('Erstgespräch', 'audio')
    const pdf = sessions.createSession('Austrittsbericht', 'pdf')
    touch('dossier', hofer)
    touch('session', audio.id)
    touch('session', pdf.id)
    expect(keys(recent.list())).toEqual(['s:Austrittsbericht', 's:Erstgespräch', 'd:Hofer'])

    // Erneut geöffnet → wieder vorne, kein doppelter Eintrag
    touch('dossier', hofer)
    expect(keys(recent.list())).toEqual(['d:Hofer', 's:Austrittsbericht', 's:Erstgespräch'])
    expect(recentEvents.count).toBe(4)
  })

  it('hält die Reihenfolge auch bei zwei Aufrufen in derselben Millisekunde', () => {
    const a = dossier('Alpha')
    const b = dossier('Beta')
    const same = new Date('2026-11-14T08:00:00.000Z')
    recent.touch({ kind: 'dossier', id: a }, same)
    recent.touch({ kind: 'dossier', id: b }, same)
    recent.touch({ kind: 'dossier', id: a }, same)
    expect(keys(recent.list())).toEqual(['d:Alpha', 'd:Beta'])
  })

  it(`behält höchstens ${RECENT_LIMIT} Einträge (AK 1)`, () => {
    for (let i = 0; i < 12; i++) touch('dossier', dossier(`Nachname${i}`))
    expect(keys(recent.list())).toEqual([11, 10, 9, 8, 7, 6, 5, 4].map((i) => `d:Nachname${i}`))
    expect(db.prepare('SELECT COUNT(*) AS n FROM recent_items').get()).toEqual({
      n: RECENT_LIMIT
    })
  })

  it('stellt eine laufende Aufnahme vor alle anderen, auch wenn sie herausgefallen ist (AK 2)', () => {
    const rec = sessions.createSession('Aufnahme läuft', 'audio')
    touch('session', rec.id)
    activeSessionId = rec.id
    touch('dossier', dossier('Hofer'))
    expect(keys(recent.list())).toEqual(['s:Aufnahme läuft', 'd:Hofer'])
    expect(recent.list()[0]).toMatchObject({ kind: 'session', recording: true })

    // Acht weitere Dossiers geöffnet: die Aufnahme bleibt vorn, insgesamt acht
    for (let i = 0; i < 8; i++) touch('dossier', dossier(`N${i}`))
    const list = recent.list()
    expect(list).toHaveLength(RECENT_LIMIT)
    expect(keys(list)[0]).toBe('s:Aufnahme läuft')
    expect(list.filter((e) => e.kind === 'session' && e.recording)).toHaveLength(1)

    activeSessionId = null
    expect(keys(recent.list())).not.toContain('s:Aufnahme läuft')
  })

  it('merkt nichts Gelöschtes oder Unbekanntes', () => {
    recent.touch({ kind: 'dossier', id: 'gibt-es-nicht' })
    recent.touch({ kind: 'session', id: 'gibt-es-nicht' })
    expect(db.prepare('SELECT COUNT(*) AS n FROM recent_items').get()).toEqual({ n: 0 })
    expect(recentEvents.count).toBe(0)
  })

  describe('Löschen (PC 2)', () => {
    it('ein gelöschtes Dossier verschwindet sofort samt Zeile', () => {
      const hofer = dossier('Hofer')
      const keller = dossier('Keller')
      touch('dossier', hofer)
      touch('dossier', keller)
      dossiers.deleteDossier(hofer, dossiers.deletePreview(hofer)!.fingerprint)
      expect(keys(recent.list())).toEqual(['d:Keller'])
      expect(
        db.prepare('SELECT COUNT(*) AS n FROM recent_items WHERE dossier_id = ?').get(hofer)
      ).toEqual({ n: 0 })
    })

    it('eine gelöschte Sitzung verschwindet sofort samt Zeile', () => {
      const s = sessions.createSession('Erstgespräch', 'audio')
      touch('session', s.id)
      sessions.deleteSession(s.id)
      expect(recent.list()).toEqual([])
      expect(db.prepare('SELECT COUNT(*) AS n FROM recent_items').get()).toEqual({ n: 0 })
    })

    it('auch während ihr Löschen noch läuft — Zeile mit der Markierung weg', () => {
      const hofer = dossier('Hofer')
      const s = sessions.createSession('Nur Hofer', 'pdf')
      db.prepare(
        'INSERT INTO session_dossiers (session_id, dossier_id, assigned_at) VALUES (?, ?, ?)'
      ).run(s.id, hofer, 'x')
      touch('session', s.id)
      touch('dossier', hofer)
      // Phase 2 hängt (Datei gesperrt, Absturz, gestaffelter Index)
      vi.spyOn(SessionService.prototype, 'finishDeletion').mockReturnValue(false)
      dossiers.deleteDossier(hofer, dossiers.deletePreview(hofer)!.fingerprint)

      expect(sessions.getAllSessionIds()).toContain(s.id)
      expect(recent.list()).toEqual([])
      expect(db.prepare('SELECT COUNT(*) AS n FROM recent_items').get()).toEqual({ n: 0 })
    })

    it('blendet eine markierte Sitzung auch dann aus, wenn ihre Zeile noch da wäre', () => {
      const s = sessions.createSession('Im Löschen', 'audio')
      touch('session', s.id)
      // Bestand vor diesem Stand: Zeile in recent_items, Sitzung schon markiert
      db.prepare('UPDATE sessions SET deleting_at = ? WHERE id = ?').run('x', s.id)
      expect(recent.list()).toEqual([])
    })
  })
})

describe('RecentService auf einer Datenbankdatei (#213 PC 1/2)', () => {
  let dbPath: string

  beforeEach(() => {
    home.path = mkdtempSync(join(tmpdir(), 'recent-file-test-'))
    dbPath = join(home.path, 'therascript.db')
    initDatabase(dbPath)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    try {
      closeDatabase()
    } catch {
      // schon geschlossen
    }
    rmSync(home.path, { recursive: true, force: true })
  })

  it('übersteht einen Neustart (PC 1)', () => {
    const dossiers = new DossierService(getDatabase())
    const r = dossiers.create({ firstName: 'Lukas', lastName: 'Hofer' })
    if (!r.ok) throw new Error('create failed')
    const s = new SessionService(getDatabase()).createSession('Erstgespräch', 'audio')
    new RecentService(getDatabase()).touch({ kind: 'dossier', id: r.dossier.id })
    new RecentService(getDatabase()).touch({ kind: 'session', id: s.id })

    closeDatabase()
    initDatabase(dbPath)
    expect(keys(new RecentService(getDatabase()).list())).toEqual(['s:Erstgespräch', 'd:Hofer'])
  })

  it('lässt nach dem Löschen keinen Verweis in .db oder -wal zurück (PC 2)', () => {
    const dossiers = new DossierService(getDatabase())
    const sessions = new SessionService(getDatabase())
    const r = dossiers.create({ firstName: 'Lukas', lastName: 'Hofer' })
    if (!r.ok) throw new Error('create failed')
    const dossierId = r.dossier.id
    const exclusive = sessions.createSession('Nur Hofer', 'audio')
    const single = sessions.createSession('Einzeln', 'pdf')
    getDatabase()
      .prepare(
        'INSERT INTO session_dossiers (session_id, dossier_id, assigned_at) VALUES (?, ?, ?)'
      )
      .run(exclusive.id, dossierId, 'x')
    const recent = new RecentService(getDatabase())
    recent.touch({ kind: 'dossier', id: dossierId })
    recent.touch({ kind: 'session', id: exclusive.id })
    recent.touch({ kind: 'session', id: single.id })
    getDatabase().pragma('wal_checkpoint(TRUNCATE)')
    const ids = [dossierId, exclusive.id, single.id]
    const anyFile = (n: string): boolean =>
      fileContains(dbPath, n) || fileContains(`${dbPath}-wal`, n)
    for (const id of ids) expect(anyFile(id), id).toBe(true)

    dossiers.deleteDossier(dossierId, dossiers.deletePreview(dossierId)!.fingerprint)
    sessions.deleteSession(single.id)

    expect(recent.list()).toEqual([])
    for (const id of ids) {
      expect(fileContains(dbPath, id), `.db: ${id}`).toBe(false)
      expect(fileContains(`${dbPath}-wal`, id), `-wal: ${id}`).toBe(false)
    }
  })
})
