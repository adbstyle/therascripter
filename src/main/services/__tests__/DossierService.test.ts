import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const home = vi.hoisted(() => ({ path: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => home.path }
}))

const events = vi.hoisted(() => ({
  sessions: [] as string[][],
  dossiers: [] as string[][]
}))
vi.mock('../ChangeEvents', () => ({
  notifySessionsChanged: (ids: string[] = []) => events.sessions.push([...ids]),
  notifyDossiersChanged: (ids: string[] = []) => events.dossiers.push([...ids])
}))

import { DossierService } from '../DossierService'
import { SessionService } from '../SessionService'
import { applyTestSchema } from '../../db/__tests__/test-utils'
import type { Dossier } from '../../../shared/types/Dossier'

function created(result: ReturnType<DossierService['create']>): Dossier {
  if (!result.ok) throw new Error(`create failed: ${result.reason}`)
  return result.dossier
}

describe('DossierService', () => {
  let db: Database.Database
  let service: DossierService
  let sessions: SessionService
  let activeSessionId: string | null

  function assign(sessionId: string, dossierId: string): void {
    db.prepare(
      'INSERT INTO session_dossiers (session_id, dossier_id, assigned_at) VALUES (?, ?, ?)'
    ).run(sessionId, dossierId, new Date().toISOString())
  }

  beforeEach(() => {
    home.path = mkdtempSync(join(tmpdir(), 'dossier-service-test-'))
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    applyTestSchema(db)
    activeSessionId = null
    service = new DossierService(db, { getActiveSessionId: () => activeSessionId })
    sessions = new SessionService(db)
    events.sessions.length = 0
    events.dossiers.length = 0
  })

  afterEach(() => {
    vi.restoreAllMocks()
    db.close()
    rmSync(home.path, { recursive: true, force: true })
  })

  describe('create', () => {
    it('stores first and last name, trimmed and composed (AK 1/2)', () => {
      const dossier = created(service.create({ firstName: '  Anna ', lastName: 'Mu\u0308ller' }))
      expect(dossier).toMatchObject({
        firstName: 'Anna',
        lastName: 'Müller',
        externalId: null,
        birthDate: null,
        diagnoses: '',
        medication: '',
        note: ''
      })
      expect(service.get(dossier.id)).toEqual(dossier)
      expect(events.dossiers).toEqual([[]])
    })

    it('stores external id and birth date; an empty id is stored as none (AK 3)', () => {
      const withId = created(
        service.create({
          firstName: 'Anna',
          lastName: 'Meier',
          externalId: ' PD-1188 ',
          birthDate: '1978-02-03'
        })
      )
      expect(withId.externalId).toBe('PD-1188')
      expect(withId.birthDate).toBe('1978-02-03')

      const blank = created(
        service.create({ firstName: 'Ben', lastName: 'Huber', externalId: ' ' })
      )
      expect(blank.externalId).toBeNull()
      // Mehrere Dossiers ohne ID sind erlaubt
      const second = created(service.create({ firstName: 'Cleo', lastName: 'Huber' }))
      expect(second.externalId).toBeNull()
    })

    it('rejects an external id another dossier already has — case, whitespace and umlauts ignored (AK 5/7)', () => {
      created(service.create({ firstName: 'Anna', lastName: 'Meier', externalId: 'Müller-01' }))
      for (const externalId of ['müller-01', ' MUELLER-01 ', 'Mu\u0308ller-01']) {
        expect(service.create({ firstName: 'Ben', lastName: 'Huber', externalId })).toEqual({
          ok: false,
          reason: 'external-id-taken',
          ownerName: 'Meier, Anna'
        })
      }
      expect(service.list()).toHaveLength(1)
    })

    it('warns about the same name and creates it after confirmation (AK 6/7)', () => {
      const first = created(service.create({ firstName: 'Jörg', lastName: 'Bär' }))

      const warned = service.create({ firstName: ' joerg', lastName: 'BAER ' })
      expect(warned.ok).toBe(false)
      if (warned.ok || warned.reason !== 'duplicate-name') throw new Error('expected duplicate')
      expect(warned.duplicates.map((d) => d.id)).toEqual([first.id])
      expect(service.list()).toHaveLength(1)

      const second = created(
        service.create({ firstName: 'Joerg', lastName: 'Baer', confirmDuplicate: true })
      )
      expect(service.list().map((d) => d.id)).toContain(second.id)
    })

    it('does not warn for a different first name', () => {
      created(service.create({ firstName: 'Anna', lastName: 'Meier' }))
      expect(service.create({ firstName: 'Anne', lastName: 'Meier' }).ok).toBe(true)
    })

    it('reports a concurrent unique violation as external-id-taken', () => {
      created(service.create({ firstName: 'Anna', lastName: 'Meier', externalId: 'PD-1' }))
      // Simuliert: die Vorprüfung sah die ID noch frei, der Unique-Index entscheidet.
      const repo = (service as unknown as { repository: { findByExternalIdNorm: () => unknown } })
        .repository
      const original = repo.findByExternalIdNorm.bind(repo)
      let calls = 0
      vi.spyOn(repo, 'findByExternalIdNorm').mockImplementation((...args: unknown[]) => {
        calls++
        return calls === 1 ? null : (original as (...a: unknown[]) => unknown)(...args)
      })
      expect(service.create({ firstName: 'Ben', lastName: 'Huber', externalId: 'pd-1' })).toEqual({
        ok: false,
        reason: 'external-id-taken',
        ownerName: 'Meier, Anna'
      })
    })

    it('rejects an invalid or future birth date (AK 8)', () => {
      expect(() =>
        service.create({ firstName: 'A', lastName: 'B', birthDate: '2023-02-29' })
      ).toThrow()
      expect(() =>
        service.create({ firstName: 'A', lastName: 'B', birthDate: '2999-01-01' })
      ).toThrow()
    })
  })

  // Review #217: der Service prüft dieselben Regeln wie die Schemas
  describe('control and invisible characters', () => {
    it('rejects control characters in names, id and free text', () => {
      expect(() => service.create({ firstName: 'An\u0000na', lastName: 'M' })).toThrow()
      expect(() =>
        service.create({ firstName: 'A', lastName: 'M', externalId: 'PD\u00071' })
      ).toThrow()
      const anna = created(service.create({ firstName: 'Anna', lastName: 'Meier' }))
      expect(() => service.update(anna.id, { note: 'x\u0000y' })).toThrow()
      expect(service.update(anna.id, { note: 'Zeile 1\nZeile 2\tTab' }).ok).toBe(true)
    })

    it('treats invisible-only names as empty and ignores invisible characters for equality', () => {
      expect(() => service.create({ firstName: '\u200B\uFEFF', lastName: 'Meier' })).toThrow()
      const anna = created(service.create({ firstName: '\u200BAnna', lastName: 'Meier' }))
      expect(anna.firstName).toBe('Anna')
      const dup = service.create({ firstName: 'Anna\u200D', lastName: 'Meier' })
      expect(dup.ok === false && dup.reason).toBe('duplicate-name')
      const blankId = created(
        service.create({ firstName: 'Ben', lastName: 'Huber', externalId: '\u200B ' })
      )
      expect(blankId.externalId).toBeNull()
    })
  })

  describe('update', () => {
    let anna: Dossier

    beforeEach(() => {
      anna = created(service.create({ firstName: 'Anna', lastName: 'Meier', externalId: 'PD-1' }))
      events.dossiers.length = 0
    })

    it('patches a single field and leaves the others untouched (AK 9/10)', () => {
      const result = service.update(anna.id, { diagnoses: 'F32.1\nF41.1' })
      expect(result.ok).toBe(true)
      const stored = service.get(anna.id)!
      expect(stored).toMatchObject({
        firstName: 'Anna',
        lastName: 'Meier',
        externalId: 'PD-1',
        diagnoses: 'F32.1\nF41.1',
        medication: '',
        note: ''
      })
      expect(stored.updatedAt >= anna.updatedAt).toBe(true)
    })

    it('sends dossiers:changed only for fields shown elsewhere', () => {
      service.update(anna.id, { note: 'Freitext' })
      service.update(anna.id, { medication: 'Sertralin' })
      expect(events.dossiers).toEqual([])
      service.update(anna.id, { lastName: 'Huber' })
      service.update(anna.id, { birthDate: '1980-01-01' })
      expect(events.dossiers).toHaveLength(2)
    })

    it('rejects an external id of another dossier and saves nothing (AK 5)', () => {
      created(service.create({ firstName: 'Ben', lastName: 'Huber', externalId: 'PD-2' }))
      expect(service.update(anna.id, { externalId: 'pd-2' })).toEqual({
        ok: false,
        reason: 'external-id-taken',
        ownerName: 'Huber, Ben'
      })
      expect(service.get(anna.id)?.externalId).toBe('PD-1')
    })

    it('allows re-saving the own id in another spelling and clearing it', () => {
      expect(service.update(anna.id, { externalId: 'pd-1' }).ok).toBe(true)
      expect(service.get(anna.id)?.externalId).toBe('pd-1')
      expect(service.update(anna.id, { externalId: null }).ok).toBe(true)
      expect(service.get(anna.id)?.externalId).toBeNull()
      expect(service.update(anna.id, { externalId: '' }).ok).toBe(true)
      expect(service.get(anna.id)?.externalId).toBeNull()
    })

    it('saves a duplicate name and reports it (AK 6)', () => {
      const ben = created(service.create({ firstName: 'Anna', lastName: 'Huber' }))
      const result = service.update(ben.id, { lastName: ' MEIER' })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.dossier.lastName).toBe('MEIER')
      expect(result.duplicates.map((d) => d.id)).toEqual([anna.id])
      // Andere Felder melden den Namensgleichen ebenfalls (Hinweis bleibt stehen)
      const again = service.update(ben.id, { note: 'x' })
      expect(again.ok && again.duplicates.map((d) => d.id)).toEqual([anna.id])
    })

    it('reports not-found for an unknown dossier', () => {
      expect(service.update('missing', { note: 'x' })).toEqual({ ok: false, reason: 'not-found' })
    })
  })

  describe('list', () => {
    it('sorts by last name, then first name, umlauts as two letters (AK 12)', () => {
      for (const [firstName, lastName] of [
        ['Zora', 'Muster'],
        ['Anna', 'Müller'],
        ['Ben', 'Mueller'],
        ['Carl', 'Mudry'],
        ['Dora', 'Ärni'],
        ['Emil', 'aebi']
      ]) {
        created(service.create({ firstName, lastName, confirmDuplicate: true }))
      }
      expect(service.list().map((d) => `${d.lastName}, ${d.firstName}`)).toEqual([
        'aebi, Emil',
        'Ärni, Dora',
        'Mudry, Carl',
        'Müller, Anna',
        'Mueller, Ben',
        'Muster, Zora'
      ])
    })

    it('counts entries and the latest entry day, ignoring sessions being deleted', () => {
      const anna = created(service.create({ firstName: 'Anna', lastName: 'Meier' }))
      const empty = created(service.create({ firstName: 'Ben', lastName: 'Huber' }))
      const audio = sessions.createSession('Sitzung', 'audio')
      const pdf = sessions.createSession('Bericht', 'pdf')
      const gone = sessions.createSession('Weg', 'audio')
      db.prepare("UPDATE sessions SET created_at = '2026-01-10T10:00:00.000Z' WHERE id = ?").run(
        audio.id
      )
      db.prepare(
        "UPDATE sessions SET created_at = '2026-01-05T10:00:00.000Z', document_date = '2026-02-01' WHERE id = ?"
      ).run(pdf.id)
      db.prepare(
        "UPDATE sessions SET created_at = '2026-03-01T10:00:00.000Z', deleting_at = 'x' WHERE id = ?"
      ).run(gone.id)
      assign(audio.id, anna.id)
      assign(pdf.id, anna.id)
      assign(gone.id, anna.id)

      const list = service.list()
      expect(list.find((d) => d.id === anna.id)).toMatchObject({
        entryCount: 2,
        lastEntryDay: '2026-02-01'
      })
      expect(list.find((d) => d.id === empty.id)).toMatchObject({
        entryCount: 0,
        lastEntryDay: null
      })
      // Keine Freitexte in der Übersicht
      expect(Object.keys(list[0]).sort()).toEqual(
        [
          'birthDate',
          'entryCount',
          'externalId',
          'firstName',
          'id',
          'lastEntryDay',
          'lastName'
        ].sort()
      )
    })

    it('lists 500 dossiers without noticeable delay (AK 15)', () => {
      const insert = db.prepare(
        `INSERT INTO dossiers (id, first_name, last_name, first_name_norm, last_name_norm,
           external_id, external_id_norm, diagnoses, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      db.transaction(() => {
        for (let i = 0; i < 500; i++) {
          const last = `Nachname${String(499 - i).padStart(3, '0')}`
          insert.run(
            `d${i}`,
            `Vorname${i}`,
            last,
            `vorname${i}`,
            last.toLowerCase(),
            `PD-${i}`,
            `pd-${i}`,
            'Diagnose '.repeat(200),
            'x',
            'x'
          )
        }
      })()
      const audio = sessions.createSession('Sitzung', 'audio')
      for (let i = 0; i < 500; i += 5) assign(audio.id, `d${i}`)

      service.list() // Warm-up (Statement-Cache)
      const start = performance.now()
      const list = service.list()
      const elapsed = performance.now() - start

      expect(list).toHaveLength(500)
      expect(list[0].lastName).toBe('Nachname000')
      // Grosszügig, damit langsame CI-Maschinen nicht flackern
      expect(elapsed).toBeLessThan(1000)
    })
  })

  describe('deletePreview', () => {
    it('returns null for an unknown dossier', () => {
      expect(service.deletePreview('missing')).toBeNull()
    })

    it('counts exclusive and shared entries and names the other dossiers', () => {
      const anna = created(service.create({ firstName: 'Anna', lastName: 'Meier' }))
      const ben = created(service.create({ firstName: 'Ben', lastName: 'Huber' }))
      const exclusiveAudio = sessions.createSession('A', 'audio')
      const exclusivePdf = sessions.createSession('B', 'pdf')
      const sharedAudio = sessions.createSession('C', 'audio')
      assign(exclusiveAudio.id, anna.id)
      assign(exclusivePdf.id, anna.id)
      assign(sharedAudio.id, anna.id)
      assign(sharedAudio.id, ben.id)

      const preview = service.deletePreview(anna.id)!
      expect(preview).toMatchObject({
        dossierId: anna.id,
        displayName: 'Anna Meier',
        exclusive: { sessions: 1, pdfs: 1 },
        shared: { sessions: 1, pdfs: 0 },
        blockedByRecording: false
      })
      expect(preview.shared.otherDossiers.map((d) => d.id)).toEqual([ben.id])
      expect(preview.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    })

    it('without entries: zero counts, stable fingerprint', () => {
      const anna = created(service.create({ firstName: 'Anna', lastName: 'Meier' }))
      const preview = service.deletePreview(anna.id)!
      expect(preview.exclusive).toEqual({ sessions: 0, pdfs: 0 })
      expect(preview.shared).toEqual({ sessions: 0, pdfs: 0, otherDossiers: [] })
      expect(service.deletePreview(anna.id)!.fingerprint).toBe(preview.fingerprint)
    })

    it('is blocked by an exclusive running recording, not by a shared one', () => {
      const anna = created(service.create({ firstName: 'Anna', lastName: 'Meier' }))
      const ben = created(service.create({ firstName: 'Ben', lastName: 'Huber' }))
      const recording = sessions.createSession('Aufnahme', 'audio')
      assign(recording.id, anna.id)
      activeSessionId = recording.id
      expect(service.deletePreview(anna.id)!.blockedByRecording).toBe(true)

      assign(recording.id, ben.id)
      expect(service.deletePreview(anna.id)!.blockedByRecording).toBe(false)
    })
  })

  describe('deleteDossier', () => {
    it('deletes the dossier, its recent item and its exclusive sessions with their files (AK 16, PC 3)', () => {
      const anna = created(service.create({ firstName: 'Anna', lastName: 'Meier' }))
      const ben = created(service.create({ firstName: 'Ben', lastName: 'Huber' }))
      const exclusive = sessions.createSession('Exklusiv', 'audio')
      const shared = sessions.createSession('Geteilt', 'pdf')
      assign(exclusive.id, anna.id)
      assign(shared.id, anna.id)
      assign(shared.id, ben.id)
      db.prepare('INSERT INTO recent_items (dossier_id, opened_at) VALUES (?, ?)').run(anna.id, 'x')
      const audioDir = join(home.path, '.therascript', 'audio')
      mkdirSync(audioDir, { recursive: true })
      const audioPath = join(audioDir, `${exclusive.id}.wav`)
      writeFileSync(audioPath, 'audio')
      events.sessions.length = 0
      events.dossiers.length = 0

      const { fingerprint } = service.deletePreview(anna.id)!
      expect(service.deleteDossier(anna.id, fingerprint)).toEqual({
        ok: true,
        deletedSessionIds: [exclusive.id],
        incomplete: false
      })

      expect(service.get(anna.id)).toBeNull()
      expect(service.list().map((d) => d.id)).toEqual([ben.id])
      expect(db.prepare('SELECT id FROM sessions WHERE id = ?').get(exclusive.id)).toBeUndefined()
      expect(existsSync(audioPath)).toBe(false)
      expect(sessions.getSession(shared.id)?.title).toBe('Geteilt')
      expect(db.prepare('SELECT dossier_id FROM session_dossiers').all()).toEqual([
        { dossier_id: ben.id }
      ])
      expect(db.prepare('SELECT COUNT(*) AS n FROM recent_items').get()).toEqual({ n: 0 })
      expect(events.sessions).toEqual([[exclusive.id]])
      expect(events.dossiers).toEqual([[anna.id]])
    })

    it('reports not-found for an unknown dossier', () => {
      expect(service.deleteDossier('missing', 'x')).toEqual({ ok: false, reason: 'not-found' })
    })

    it('deletes nothing when the content changed since the preview', () => {
      const anna = created(service.create({ firstName: 'Anna', lastName: 'Meier' }))
      const { fingerprint } = service.deletePreview(anna.id)!
      const later = sessions.createSession('Später zugeordnet', 'audio')
      assign(later.id, anna.id)

      const result = service.deleteDossier(anna.id, fingerprint)
      expect(result.ok).toBe(false)
      if (result.ok || result.reason !== 'changed') throw new Error('expected changed')
      expect(result.preview.exclusive).toEqual({ sessions: 1, pdfs: 0 })
      expect(service.get(anna.id)).not.toBeNull()
      expect(sessions.getSession(later.id)).not.toBeNull()
    })

    it('refuses while an exclusive session is being recorded', () => {
      const anna = created(service.create({ firstName: 'Anna', lastName: 'Meier' }))
      const recording = sessions.createSession('Aufnahme', 'audio')
      assign(recording.id, anna.id)
      activeSessionId = recording.id
      const { fingerprint } = service.deletePreview(anna.id)!

      expect(service.deleteDossier(anna.id, fingerprint)).toEqual({
        ok: false,
        reason: 'blocked-recording'
      })
      expect(service.get(anna.id)).not.toBeNull()
      expect(sessions.getSession(recording.id)).not.toBeNull()
    })

    it('an interrupted deletion is completed at the next start (PC 5)', () => {
      const anna = created(service.create({ firstName: 'Anna', lastName: 'Meier' }))
      const first = sessions.createSession('Eins', 'audio')
      const second = sessions.createSession('Zwei', 'pdf')
      assign(first.id, anna.id)
      assign(second.id, anna.id)
      const { fingerprint } = service.deletePreview(anna.id)!

      // Phase 2 bricht ab (z. B. Absturz, Datei gesperrt): die Markierung aus
      // Phase 1 ist schon festgeschrieben.
      const finish = vi
        .spyOn(SessionService.prototype, 'finishDeletion')
        .mockImplementationOnce(() => {
          throw new Error('simulierter Abbruch')
        })
        .mockImplementationOnce(() => false)

      const result = service.deleteDossier(anna.id, fingerprint)
      expect(result).toMatchObject({ ok: true, incomplete: true })
      expect(service.get(anna.id)).toBeNull()
      // Für alle Lesewege schon weg, aber noch markiert vorhanden
      expect(sessions.getSession(first.id)).toBeNull()
      expect(sessions.getSession(second.id)).toBeNull()
      expect(sessions.getAllSessionIds().sort()).toEqual([first.id, second.id].sort())

      finish.mockRestore()
      // Nächster Start: derselbe Pfad wie in src/main/index.ts (#202)
      expect(new SessionService(db).finishPendingDeletions()).toBe(2)
      expect(sessions.getAllSessionIds()).toEqual([])
    })
  })
})
