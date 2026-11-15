import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * #207 — Mitlöschen beim Löschen eines Patientendossiers, über die echten
 * Services statt Einzelmethoden:
 * - PC 1: nur exklusiv zugeordnete Inhalte gehen mit, geteilte bleiben
 * - PC 2: laufende UND wartende Verarbeitung einer mitgelöschten Sitzung endet
 *   (auch wenn der Task gerade in einem Executor läuft)
 * - PC 3: mitgelöschte Inhalte sind sofort nirgends mehr sichtbar — auch wenn
 *   ihr physisches Löschen noch läuft (Sitzungsliste, Verlauf anderer
 *   Dossiers, Übersicht, Suche)
 * - AK 1: die Vorschau nennt die Suchdaten, die mitgehen (Epic EK 22)
 */

const home = vi.hoisted(() => ({ path: '' }))
vi.mock('electron', () => ({ app: { getPath: () => home.path } }))
vi.mock('../../utils/ipc-helpers', () => ({ sendToRenderer: vi.fn() }))
vi.mock('../ModelDownloadService', () => ({
  getActiveModelId: vi.fn().mockReturnValue(null),
  getModelById: vi.fn().mockReturnValue(null)
}))
// Eine Queue pro Test statt des Prozess-Singletons: SessionService erreicht
// sie beim Löschen über getTaskQueue() — wie in Produktion
const queueRef = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('../TaskQueueService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../TaskQueueService')>()
  return {
    ...actual,
    getTaskQueue: () => {
      if (!queueRef.current) throw new Error('TaskQueueService not initialized')
      return queueRef.current
    }
  }
})

import { DossierService } from '../DossierService'
import { SessionService } from '../SessionService'
import { SessionDossierService } from '../SessionDossierService'
import { TaskQueueService } from '../TaskQueueService'
import { setChangeEventSenderForTests } from '../ChangeEvents'
import { SearchService } from '../../search/SearchService'
import { SearchRecentRepository } from '../../db/repositories/SearchRecentRepository'
import { TaskRepository } from '../../db/repositories/TaskRepository'
import type { TaskExecutor } from '../task-executors'
import type { Dossier } from '../../../shared/types/Dossier'
import {
  addIndexedSession,
  createIndexService,
  createSearchTestDb,
  indexAll
} from '../../search/__tests__/helpers'

function created(result: ReturnType<DossierService['create']>): Dossier {
  if (!result.ok) throw new Error(`create failed: ${result.reason}`)
  return result.dossier
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('DossierService.deleteDossier — Mitlöschen (#207)', () => {
  let db: Database.Database
  let service: DossierService
  let sessions: SessionService
  let assignments: SessionDossierService
  const events: Array<{ channel: string; deletedIds: string[] }> = []

  beforeAll(() => {
    setChangeEventSenderForTests((channel, data) =>
      events.push({ channel, deletedIds: data.deletedIds })
    )
  })
  afterAll(() => setChangeEventSenderForTests(null))

  beforeEach(() => {
    home.path = mkdtempSync(join(tmpdir(), 'dossier-cascade-test-'))
    db = createSearchTestDb()
    service = new DossierService(db)
    sessions = new SessionService(db)
    assignments = new SessionDossierService(db)
    events.length = 0
  })

  afterEach(() => {
    vi.restoreAllMocks()
    db.close()
    rmSync(home.path, { recursive: true, force: true })
  })

  function assign(sessionId: string, dossierId: string): void {
    expect(assignments.assign(sessionId, dossierId)).toEqual({ ok: true })
  }

  it('nimmt nur die ausschliesslich zugeordneten Inhalte mit (PC 1, OOS 1)', () => {
    const anna = created(service.create({ firstName: 'Anna', lastName: 'Meier' }))
    const ben = created(service.create({ firstName: 'Ben', lastName: 'Huber' }))
    const onlyAnna = sessions.createSession('Nur Anna', 'audio')
    const onlyAnnaPdf = sessions.createSession('Bericht Anna', 'pdf')
    const both = sessions.createSession('Paargespräch', 'audio')
    const onlyBen = sessions.createSession('Nur Ben', 'pdf')
    const unassigned = sessions.createSession('Ohne Dossier', 'audio')
    assign(onlyAnna.id, anna.id)
    assign(onlyAnnaPdf.id, anna.id)
    assign(both.id, anna.id)
    assign(both.id, ben.id)
    assign(onlyBen.id, ben.id)

    const preview = service.deletePreview(anna.id)!
    expect(preview.exclusive).toEqual({ sessions: 1, pdfs: 1 })
    expect(preview.shared).toMatchObject({ sessions: 1, pdfs: 0 })

    const result = service.deleteDossier(anna.id, preview.fingerprint)
    expect(result).toMatchObject({ ok: true, incomplete: false })
    if (!result.ok) return
    expect([...result.deletedSessionIds].sort()).toEqual([onlyAnna.id, onlyAnnaPdf.id].sort())

    expect(sessions.getAllSessionIds().sort()).toEqual([both.id, onlyBen.id, unassigned.id].sort())
    // Die geteilte Sitzung bleibt unverändert in Bens Verlauf
    expect(sessions.getSession(both.id)?.title).toBe('Paargespräch')
    expect(
      assignments
        .timeline(ben.id)
        .map((e) => e.id)
        .sort()
    ).toEqual([both.id, onlyBen.id].sort())
    expect(assignments.listForSession(both.id).map((d) => d.id)).toEqual([ben.id])
  })

  it('lässt Sperrlisten-Einträge unberührt (OOS 2)', () => {
    db.prepare(
      `INSERT INTO blocklist (id, term, placeholder_type) VALUES ('b1', 'Meier', 'PERSON')`
    ).run()
    const anna = created(service.create({ firstName: 'Anna', lastName: 'Meier' }))
    const session = sessions.createSession('Nur Anna', 'audio')
    assign(session.id, anna.id)
    service.deleteDossier(anna.id, service.deletePreview(anna.id)!.fingerprint)
    expect(db.prepare('SELECT term FROM blocklist').all()).toEqual([{ term: 'Meier' }])
  })

  describe('Verarbeitung mitgelöschter Sitzungen (PC 2)', () => {
    let queue: TaskQueueService
    let tasks: TaskRepository

    beforeEach(() => {
      queue = new TaskQueueService(db)
      queueRef.current = queue
      tasks = new TaskRepository(db)
    })

    afterEach(async () => {
      queue.stop()
      queueRef.current = null
      await wait(30)
    })

    it('bricht den laufenden Task ab und verwirft wartende — die geteilte Sitzung läuft weiter', async () => {
      const started: string[] = []
      const signals = new Map<string, AbortSignal>()
      // Blockiert, bis abgebrochen wird — wie ein langer whisper-/pyannote-Lauf
      const blocking: TaskExecutor = {
        async execute(task, _onProgress, signal) {
          started.push(task.sessionId)
          signals.set(task.sessionId, signal!)
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('aborted')))
          })
        }
      }
      queue.registerExecutor('diarization', blocking)
      queue.registerExecutor('extraction', blocking)

      const anna = created(service.create({ firstName: 'Anna', lastName: 'Meier' }))
      const ben = created(service.create({ firstName: 'Ben', lastName: 'Huber' }))
      const running = sessions.createSession('Läuft', 'audio')
      sessions.updateSession(running.id, { status: 'queued' })
      const waiting = sessions.createSession('Wartet', 'pdf')
      const shared = sessions.createSession('Geteilt', 'pdf')
      assign(running.id, anna.id)
      assign(waiting.id, anna.id)
      assign(shared.id, anna.id)
      assign(shared.id, ben.id)

      queue.enqueuePipeline(running.id, 'audio')
      queue.enqueuePipeline(waiting.id, 'pdf')
      queue.enqueuePipeline(shared.id, 'pdf')
      await wait(30)
      expect(started).toEqual([running.id])
      expect(tasks.findBySession(waiting.id).every((t) => t.status === 'pending')).toBe(true)

      const result = service.deleteDossier(anna.id, service.deletePreview(anna.id)!.fingerprint)
      expect(result).toMatchObject({ ok: true })

      // Laufender Executor bekommt den Abbruch sofort, nicht erst beim nächsten Schritt
      expect(signals.get(running.id)?.aborted).toBe(true)
      // Wartende Tasks gibt es nicht mehr (Zeilen samt Sitzung gelöscht)
      expect(tasks.findBySession(waiting.id)).toEqual([])
      expect(tasks.findBySession(running.id)).toEqual([])

      await wait(60)
      // Die mitgelöschte wartende Sitzung wurde nie verarbeitet, die geteilte schon
      expect(started).toEqual([running.id, shared.id])
      expect(sessions.getSession(running.id)).toBeNull()
      expect(sessions.getSession(waiting.id)).toBeNull()
      expect(sessions.getAllSessionIds()).toEqual([shared.id])
    })

    it('beendet die Verarbeitung auch, wenn das physische Löschen erst beim nächsten Start gelingt', async () => {
      const started: string[] = []
      let aborted = false
      queue.registerExecutor('diarization', {
        async execute(task, _onProgress, signal) {
          started.push(task.sessionId)
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener('abort', () => {
              aborted = true
              reject(new Error('aborted'))
            })
          })
        }
      })

      const anna = created(service.create({ firstName: 'Anna', lastName: 'Meier' }))
      const first = sessions.createSession('Eins', 'audio')
      const second = sessions.createSession('Zwei', 'audio')
      for (const s of [first, second]) {
        sessions.updateSession(s.id, { status: 'queued' })
        assign(s.id, anna.id)
        queue.enqueuePipeline(s.id, 'audio')
      }
      await wait(30)
      expect(started).toEqual([first.id])

      // Dateien bleiben liegen (z. B. gesperrt): Zeilen bleiben markiert
      vi.spyOn(SessionService.prototype as never, 'completeDeletion').mockReturnValue(
        false as never
      )
      const result = service.deleteDossier(anna.id, service.deletePreview(anna.id)!.fingerprint)
      expect(result).toMatchObject({ ok: true, incomplete: true })
      expect(aborted).toBe(true)
      expect(tasks.findBySession(second.id).map((t) => t.status)).not.toContain('pending')

      await wait(60)
      expect(started).toEqual([first.id])
    })
  })

  describe('sofort unsichtbar, auch während das Löschen noch läuft (PC 3)', () => {
    function seed(): { anna: Dossier; ben: Dossier; docs: Map<string, unknown> } {
      const docs = new Map<string, unknown>()
      addIndexedSession(
        db,
        docs,
        { id: 'nur-anna', title: 'Erstgespräch', titlePlain: 'Erstgespräch Anna' },
        [{ speaker: 'A', text: 'Wir sprechen über die Prüfungsangst.' }]
      )
      addIndexedSession(db, docs, { id: 'geteilt', type: 'pdf', title: 'Bericht' }, [
        { text: 'Auch hier geht es um Prüfungsangst.' }
      ])
      indexAll(createIndexService(db, docs))
      const anna = created(service.create({ firstName: 'Anna', lastName: 'Meier' }))
      const ben = created(service.create({ firstName: 'Ben', lastName: 'Huber' }))
      assign('nur-anna', anna.id)
      assign('geteilt', anna.id)
      assign('geteilt', ben.id)
      return { anna, ben, docs }
    }

    function search(query: string): string[] {
      return new SearchService(db)
        .query({ requestId: 1, query, scope: { kind: 'all' } })
        .results.map((r) => r.sessionId)
        .sort()
    }

    it('Sitzungsliste, Übersicht, Verlauf und Suche — Phase 2 hängt noch', () => {
      const { anna, ben } = seed()
      expect(search('Prüfungsangst')).toEqual(['geteilt', 'nur-anna'])

      // Phase 2 kommt nicht dazu (Absturz, gesperrte Datei, gestaffelter Index)
      vi.spyOn(SessionService.prototype, 'finishDeletion').mockReturnValue(false)
      const result = service.deleteDossier(anna.id, service.deletePreview(anna.id)!.fingerprint)
      expect(result).toMatchObject({ ok: true, incomplete: true })

      // Zeile und Indexabschnitte existieren noch …
      expect(sessions.getAllSessionIds()).toContain('nur-anna')
      expect(
        (
          db
            .prepare(`SELECT COUNT(*) AS n FROM search_chunks WHERE session_id = 'nur-anna'`)
            .get() as {
            n: number
          }
        ).n
      ).toBeGreaterThan(0)

      // … aber kein Leseweg zeigt sie mehr
      expect(assignments.listSessions().map((s) => s.id)).toEqual(['geteilt'])
      expect(sessions.getSession('nur-anna')).toBeNull()
      expect(assignments.timeline(ben.id).map((e) => e.id)).toEqual(['geteilt'])
      expect(service.list()).toEqual([expect.objectContaining({ id: ben.id, entryCount: 1 })])
      expect(service.get(anna.id)).toBeNull()
      expect(search('Prüfungsangst')).toEqual(['geteilt'])
      expect(search('Anna')).toEqual([])

      // Die Oberfläche erfährt die gelöschten IDs (Navigationsverlauf, #213 PC 3)
      return wait(0).then(() => {
        expect(events).toContainEqual({ channel: 'sessions:changed', deletedIds: ['nur-anna'] })
        expect(events).toContainEqual({ channel: 'dossiers:changed', deletedIds: [anna.id] })
      })
    })
  })

  describe('Vorschau nennt die Suchdaten (AK 1, Epic EK 22)', () => {
    it('zählt mitgelöschte Inhalte mit aufbereiteten Texten und passende letzte Suchanfragen', () => {
      const docs = new Map<string, unknown>()
      addIndexedSession(db, docs, { id: 'fertig', title: 'Fertig' }, [{ text: 'Text' }])
      indexAll(createIndexService(db, docs))
      const anna = created(
        service.create({ firstName: 'Anna', lastName: 'Meier', externalId: 'PD-7' })
      )
      const processing = sessions.createSession('Wird verarbeitet', 'pdf')
      assign('fertig', anna.id)
      assign(processing.id, anna.id)

      const recent = new SearchRecentRepository(db)
      recent.remember('Meier Schlaf')
      recent.remember('pd-7')
      recent.remember('Prüfungsangst')

      expect(service.deletePreview(anna.id)!.search).toEqual({
        exclusiveSearchable: 1,
        recentQueries: 2
      })

      service.deleteDossier(anna.id, service.deletePreview(anna.id)!.fingerprint)
      expect(recent.list().map((q) => q.query)).toEqual(['Prüfungsangst'])
    })

    it('ohne Inhalte und ohne passende Anfragen: nichts zu nennen', () => {
      const anna = created(service.create({ firstName: 'Anna', lastName: 'Meier' }))
      new SearchRecentRepository(db).remember('Huber')
      expect(service.deletePreview(anna.id)!.search).toEqual({
        exclusiveSearchable: 0,
        recentQueries: 0
      })
    })
  })
})
