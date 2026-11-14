import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const home = vi.hoisted(() => ({ path: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => home.path }
}))

const events = vi.hoisted(() => ({ sessions: 0, dossiers: 0 }))
vi.mock('../ChangeEvents', () => ({
  notifySessionsChanged: () => {
    events.sessions++
  },
  notifyDossiersChanged: () => {
    events.dossiers++
  }
}))

const checkpoint = vi.hoisted(() => ({ calls: 0 }))
vi.mock('../../db/maintenance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/maintenance')>()
  return {
    ...actual,
    walCheckpointTruncate: (db: Database.Database) => {
      checkpoint.calls++
      return actual.walCheckpointTruncate(db)
    }
  }
})

import { SessionDossierService } from '../SessionDossierService'
import { SessionService } from '../SessionService'
import { DossierService } from '../DossierService'
import { applyTestSchema } from '../../db/__tests__/test-utils'
import type { SessionStatus } from '../../../shared/types'

/**
 * #205 — Zuordnen, Lösen, Verlauf und Sitzungsliste mit Plaketten. Die
 * Tagesgrenzen rechnet SQLite mit `localtime`; die Tests laufen deshalb mit
 * fester Zeitzone Europe/Zurich (Winter UTC+1, Sommer UTC+2).
 */

let previousTz: string | undefined
beforeAll(() => {
  previousTz = process.env.TZ
  process.env.TZ = 'Europe/Zurich'
})
afterAll(() => {
  if (previousTz === undefined) delete process.env.TZ
  else process.env.TZ = previousTz
})

describe('SessionDossierService', () => {
  let db: Database.Database
  let service: SessionDossierService
  let sessions: SessionService
  let dossiers: DossierService

  function dossier(firstName: string, lastName: string, externalId?: string): string {
    const result = dossiers.create({ firstName, lastName, externalId, confirmDuplicate: true })
    if (!result.ok) throw new Error(result.reason)
    return result.dossier.id
  }

  function session(
    title: string,
    type: 'audio' | 'pdf',
    createdAt: string,
    status?: SessionStatus
  ): string {
    const s = sessions.createSession(title, type)
    db.prepare('UPDATE sessions SET created_at = ? WHERE id = ?').run(createdAt, s.id)
    if (status) db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run(status, s.id)
    return s.id
  }

  function row(id: string): Record<string, unknown> {
    return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown>
  }

  function assignmentCount(): number {
    return (db.prepare('SELECT COUNT(*) AS n FROM session_dossiers').get() as { n: number }).n
  }

  beforeEach(() => {
    home.path = mkdtempSync(join(tmpdir(), 'session-dossier-test-'))
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    applyTestSchema(db)
    service = new SessionDossierService(db)
    sessions = new SessionService(db)
    dossiers = new DossierService(db)
    events.sessions = 0
    events.dossiers = 0
    checkpoint.calls = 0
  })

  afterEach(() => {
    db.close()
    rmSync(home.path, { recursive: true, force: true })
  })

  it('runs SQLite localtime in Europe/Zurich (precondition of the day-boundary tests)', () => {
    const day = db.prepare("SELECT date('2026-11-13T23:30:00.000Z', 'localtime') AS d").get() as {
      d: string
    }
    expect(day.d).toBe('2026-11-14')
  })

  describe('assign / unassign', () => {
    it('assigns a session to several dossiers and lists them alphabetically (AK 1/5)', () => {
      const hofer = dossier('Lukas', 'Hofer')
      const bachmann = dossier('Lea', 'Bachmann')
      const id = session('Erstgespräch', 'audio', '2026-11-10T09:00:00.000Z', 'review')
      events.sessions = 0
      events.dossiers = 0

      expect(service.assign(id, hofer)).toEqual({ ok: true })
      expect(service.assign(id, bachmann)).toEqual({ ok: true })

      expect(service.listForSession(id).map((d) => d.lastName)).toEqual(['Bachmann', 'Hofer'])
      expect(events.sessions).toBe(2)
      expect(events.dossiers).toBe(2)
    })

    it('treats a repeated assignment as success without a second row or event', () => {
      const hofer = dossier('Lukas', 'Hofer')
      const id = session('S', 'audio', '2026-11-10T09:00:00.000Z', 'review')
      service.assign(id, hofer)
      events.sessions = 0
      expect(service.assign(id, hofer)).toEqual({ ok: true })
      expect(assignmentCount()).toBe(1)
      expect(events.sessions).toBe(0)
    })

    it.each<SessionStatus>(['recording', 'queued', 'processing', 'error', 'review'])(
      'assigns and unassigns in status %s (AK 3)',
      (status) => {
        const hofer = dossier('Lukas', 'Hofer')
        const id = session('S', 'audio', '2026-11-10T09:00:00.000Z', status)
        expect(service.assign(id, hofer)).toEqual({ ok: true })
        expect(service.listForSession(id)).toHaveLength(1)
        expect(service.unassign(id, hofer)).toEqual({ ok: true })
        expect(service.listForSession(id)).toHaveLength(0)
      }
    )

    it('leaves everything unchanged when the session or dossier does not exist (PC 3)', () => {
      const hofer = dossier('Lukas', 'Hofer')
      const id = session('S', 'audio', '2026-11-10T09:00:00.000Z', 'review')
      service.assign(id, hofer)
      events.sessions = 0

      expect(service.assign('missing', hofer)).toEqual({ ok: false, reason: 'not-found' })
      expect(service.assign(id, 'missing')).toEqual({ ok: false, reason: 'not-found' })
      expect(service.unassign(id, 'missing')).toEqual({ ok: false, reason: 'not-found' })
      expect(service.unassign('missing', hofer)).toEqual({ ok: false, reason: 'not-found' })

      expect(service.listForSession(id).map((d) => d.id)).toEqual([hofer])
      expect(assignmentCount()).toBe(1)
      expect(events.sessions).toBe(0)
    })

    it('does not assign a session that is being deleted', () => {
      const hofer = dossier('Lukas', 'Hofer')
      const id = session('S', 'audio', '2026-11-10T09:00:00.000Z', 'review')
      db.prepare('UPDATE sessions SET deleting_at = ? WHERE id = ?').run(
        new Date().toISOString(),
        id
      )
      expect(service.assign(id, hofer)).toEqual({ ok: false, reason: 'not-found' })
      expect(assignmentCount()).toBe(0)
    })

    it('keeps the session with all content when unassigning and checkpoints the WAL (PC 1/5)', () => {
      const hofer = dossier('Lukas', 'Hofer')
      const id = session('Erstgespräch', 'pdf', '2026-11-10T09:00:00.000Z', 'review')
      service.assign(id, hofer)
      const before = row(id)
      checkpoint.calls = 0

      expect(service.unassign(id, hofer)).toEqual({ ok: true })

      expect(row(id)).toEqual(before)
      expect(assignmentCount()).toBe(0)
      expect(checkpoint.calls).toBe(1)
    })

    it('changes neither title, summary, text paths nor pseudonymization (PC 2)', () => {
      const hofer = dossier('Lukas', 'Hofer')
      const id = session('Titel mit [PERSON 1]', 'audio', '2026-11-10T09:00:00.000Z', 'review')
      db.prepare(
        `UPDATE sessions SET summary = ?, entity_map = ?, anonymized_path = ? WHERE id = ?`
      ).run('Zusammenfassung', '{"person-1":{"original":"Ruth"}}', '/x.json', id)
      const before = row(id)

      service.assign(id, hofer)
      service.unassign(id, hofer)
      service.assign(id, hofer)

      expect(row(id)).toEqual(before)
    })

    it('removes assignments with the session when it is deleted (PC 4/5)', () => {
      const hofer = dossier('Lukas', 'Hofer')
      const id = session('S', 'audio', '2026-11-10T09:00:00.000Z', 'review')
      service.assign(id, hofer)
      expect(sessions.deleteSession(id)).toBe(true)
      expect(assignmentCount()).toBe(0)
      expect(service.timeline(hofer)).toEqual([])
    })

    it('keeps unassigned sessions fully usable (AK 4)', () => {
      const id = session('Ohne Dossier', 'audio', '2026-11-10T09:00:00.000Z', 'review')
      const list = service.listSessions()
      expect(list).toHaveLength(1)
      expect(list[0]).toMatchObject({ id, title: 'Ohne Dossier', dossiers: [] })
    })
  })

  describe('timeline', () => {
    it('orders by day, sessions before PDFs, PDFs by import time — youngest first (AK 6/8/9)', () => {
      const hofer = dossier('Lukas', 'Hofer')
      const ids = {
        pdfEarly: session('PDF früh importiert', 'pdf', '2026-11-12T07:00:00.000Z', 'review'),
        pdfLate: session('PDF spät importiert', 'pdf', '2026-11-12T15:00:00.000Z', 'review'),
        sessionMorning: session('Sitzung morgens', 'audio', '2026-11-12T08:00:00.000Z', 'review'),
        sessionEvening: session('Sitzung abends', 'audio', '2026-11-12T17:00:00.000Z', 'review'),
        older: session('Ältere Sitzung', 'audio', '2026-11-05T09:00:00.000Z', 'review'),
        newest: session('Neueste', 'audio', '2026-11-13T09:00:00.000Z', 'review')
      }
      for (const id of Object.values(ids)) service.assign(id, hofer)

      expect(service.timeline(hofer).map((e) => e.title)).toEqual([
        'Neueste',
        'Sitzung abends',
        'Sitzung morgens',
        'PDF spät importiert',
        'PDF früh importiert',
        'Ältere Sitzung'
      ])
    })

    it('places a PDF by its document date, otherwise by its import day (AK 8/19)', () => {
      const hofer = dossier('Lukas', 'Hofer')
      const report = session('Austrittsbericht', 'pdf', '2026-11-13T09:00:00.000Z', 'review')
      const recent = session('Sitzung', 'audio', '2026-11-10T09:00:00.000Z', 'review')
      const referral = session('Überweisung', 'pdf', '2026-11-08T09:00:00.000Z', 'review')
      for (const id of [report, recent, referral]) service.assign(id, hofer)

      expect(sessions.setDocumentDate(report, '2026-10-02')).toEqual({ ok: true })

      const timeline = service.timeline(hofer)
      expect(timeline.map((e) => [e.title, e.sortDay])).toEqual([
        ['Sitzung', '2026-11-10'],
        ['Überweisung', '2026-11-08'],
        ['Austrittsbericht', '2026-10-02']
      ])
      expect(timeline.find((e) => e.id === referral)?.documentDate).toBeNull()
    })

    it('uses the same document date in every dossier (AK 22)', () => {
      const hofer = dossier('Lukas', 'Hofer')
      const maria = dossier('Maria', 'Hofer')
      const report = session('Bericht', 'pdf', '2026-11-13T09:00:00.000Z', 'review')
      service.assign(report, hofer)
      service.assign(report, maria)
      sessions.setDocumentDate(report, '2026-09-30')
      for (const owner of [hofer, maria]) {
        expect(service.timeline(owner).map((e) => [e.sortDay, e.documentDate])).toEqual([
          ['2026-09-30', '2026-09-30']
        ])
      }
    })

    it('counts the local day just after midnight, in winter and in summer time', () => {
      const hofer = dossier('Lukas', 'Hofer')
      // 00:30 lokal (UTC+1) — in UTC noch der Vortag
      const winter = session('Winter', 'audio', '2026-11-13T23:30:00.000Z', 'review')
      // 00:15 lokal (UTC+2)
      const summer = session('Sommer', 'audio', '2026-07-01T22:15:00.000Z', 'review')
      // 23:45 lokal am 1. Juli
      const summerLate = session('Sommer spät', 'audio', '2026-07-01T21:45:00.000Z', 'review')
      // Nacht der Umstellung auf Sommerzeit (29.03.2026): 00:30 lokal, noch UTC+1
      const dst = session('Umstellung', 'audio', '2026-03-28T23:30:00.000Z', 'review')
      for (const id of [winter, summer, summerLate, dst]) service.assign(id, hofer)

      const days = Object.fromEntries(service.timeline(hofer).map((e) => [e.title, e.sortDay]))
      expect(days).toEqual({
        Winter: '2026-11-14',
        Sommer: '2026-07-02',
        'Sommer spät': '2026-07-01',
        Umstellung: '2026-03-29'
      })
    })

    it('puts a PDF imported just after midnight on the same day as that day’s session', () => {
      const hofer = dossier('Lukas', 'Hofer')
      const pdf = session('PDF', 'pdf', '2026-11-13T23:10:00.000Z', 'review') // 00:10 am 14.11.
      const audio = session('Sitzung', 'audio', '2026-11-14T08:00:00.000Z', 'review')
      service.assign(pdf, hofer)
      service.assign(audio, hofer)
      expect(service.timeline(hofer).map((e) => [e.title, e.sortDay])).toEqual([
        ['Sitzung', '2026-11-14'],
        ['PDF', '2026-11-14']
      ])
    })

    it('orders entries with identical timestamps stably by id (AK 9 «stets gleich»)', () => {
      const hofer = dossier('Lukas', 'Hofer')
      const a = session('A', 'audio', '2026-11-12T08:00:00.000Z', 'review')
      const b = session('B', 'audio', '2026-11-12T08:00:00.000Z', 'review')
      service.assign(a, hofer)
      service.assign(b, hofer)
      const expected = [a, b].sort().reverse()
      expect(service.timeline(hofer).map((e) => e.id)).toEqual(expected)
      expect(service.timeline(hofer).map((e) => e.id)).toEqual(expected)
    })

    it('shows a shared entry in every dossier with its other dossiers (AK 7)', () => {
      const hofer = dossier('Lukas', 'Hofer')
      const maria = dossier('Maria', 'Hofer')
      const id = session('Paargespräch', 'audio', '2026-10-30T15:30:00.000Z', 'review')
      db.prepare('UPDATE sessions SET summary = ? WHERE id = ?').run('Gemeinsame Sitzung', id)
      service.assign(id, hofer)
      service.assign(id, maria)

      for (const owner of [hofer, maria]) {
        const [entry] = service.timeline(owner)
        expect(entry).toMatchObject({ id, title: 'Paargespräch', summary: 'Gemeinsame Sitzung' })
        expect(entry.dossiers.map((d) => d.firstName)).toEqual(['Lukas', 'Maria'])
      }
    })

    it('hides sessions that are being deleted (PC 4)', () => {
      const hofer = dossier('Lukas', 'Hofer')
      const id = session('S', 'audio', '2026-11-10T09:00:00.000Z', 'review')
      service.assign(id, hofer)
      db.prepare('UPDATE sessions SET deleting_at = ? WHERE id = ?').run(
        new Date().toISOString(),
        id
      )
      expect(service.timeline(hofer)).toEqual([])
      expect(service.listSessions()).toEqual([])
    })

    it('carries status, error and the current title/summary of every entry (AK 10–14)', () => {
      const hofer = dossier('Lukas', 'Hofer')
      const failed = session('Fehlgeschlagen', 'audio', '2026-11-10T09:00:00.000Z', 'error')
      db.prepare('UPDATE sessions SET error_message = ? WHERE id = ?').run('Kaputt', failed)
      service.assign(failed, hofer)
      sessions.updateTitle(failed, 'Neuer Titel')

      const [entry] = service.timeline(hofer)
      expect(entry).toMatchObject({
        status: 'error',
        errorMessage: 'Kaputt',
        title: 'Neuer Titel',
        type: 'audio'
      })
    })
  })

  describe('listSessions', () => {
    it('adds the dossiers of each session (AK 5)', () => {
      const hofer = dossier('Lukas', 'Hofer')
      const a = session('A', 'audio', '2026-11-10T09:00:00.000Z', 'review')
      const b = session('B', 'pdf', '2026-11-11T09:00:00.000Z', 'review')
      service.assign(a, hofer)

      const list = service.listSessions()
      expect(list.map((s) => [s.title, s.dossiers.map((d) => d.lastName)])).toEqual([
        ['B', []],
        ['A', ['Hofer']]
      ])
      expect(list[0].id).toBe(b)
    })

    it('stays fast with 2000 sessions, 500 dossiers and a 300-entry timeline (NFR 3, AK 25)', () => {
      const insertSession = db.prepare(
        `INSERT INTO sessions (id, title, type, status, created_at, updated_at, summary)
         VALUES (?, ?, ?, 'review', ?, ?, ?)`
      )
      const insertDossier = db.prepare(
        `INSERT INTO dossiers (id, first_name, last_name, first_name_norm, last_name_norm,
           created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      const insertAssignment = db.prepare(
        'INSERT INTO session_dossiers (session_id, dossier_id, assigned_at) VALUES (?, ?, ?)'
      )
      const now = new Date().toISOString()
      db.transaction(() => {
        insertDossier.run('d-big', 'Viele', 'Einträge', 'viele', 'eintraege', now, now)
        for (let d = 0; d < 500; d++) {
          insertDossier.run(
            `d${d}`,
            `Vorname${d}`,
            `Nachname${d}`,
            `vorname${d}`,
            `nachname${d}`,
            now,
            now
          )
        }
        for (let i = 0; i < 2000; i++) {
          const created = new Date(Date.UTC(2024, 0, 1) + i * 3_600_000 * 9).toISOString()
          insertSession.run(
            `s${i}`,
            `Sitzung ${i}`,
            i % 4 === 0 ? 'pdf' : 'audio',
            created,
            created,
            'Zusammenfassung '.repeat(20)
          )
          insertAssignment.run(`s${i}`, `d${i % 500}`, now)
          if (i < 300) insertAssignment.run(`s${i}`, 'd-big', now)
        }
      })()
      let start = performance.now()
      const list = service.listSessions()
      const listMs = performance.now() - start
      expect(list).toHaveLength(2000)
      expect(list.find((s) => s.id === 's0')?.dossiers).toHaveLength(2)

      start = performance.now()
      const timeline = service.timeline('d-big')
      const timelineMs = performance.now() - start
      expect(timeline).toHaveLength(300)

      // Budget für den Main-Prozess-Anteil; die Anzeige hat ihr eigenes (Renderer-Test)
      expect(listMs).toBeLessThan(300)
      expect(timelineMs).toBeLessThan(100)
    })
  })
})
