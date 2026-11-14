import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// #204 Postcondition 4: nach dem bestätigten Löschen ist ein Patientendossier
// (samt exklusiv zugeordneter Sitzungen) in den Dateien der App weder
// auffindbar noch wiederherstellbar. Echte Datenbankdatei mit WAL, Suche in
// den Rohbytes — wie SessionService.secureDelete.test.ts (#202).
// Postcondition 5: ein unterbrochenes Löschen schliesst der nächste Start ab.

const home = vi.hoisted(() => ({ path: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => home.path },
  BrowserWindow: { getAllWindows: () => [] }
}))

import { initDatabase, getDatabase, closeDatabase } from '../../db/connection'
import { DossierService } from '../DossierService'
import { SessionService } from '../SessionService'
import { normalizeDossierKey } from '../../../shared/utils/dossier-normalize'

const MARKER = 'ZQX-Dossier-Geheimnis-4417'

function fileContains(path: string, needle: string): boolean {
  if (!existsSync(path)) return false
  return readFileSync(path).includes(Buffer.from(needle, 'utf-8'))
}

describe('DossierService.deleteDossier — nothing recoverable on disk', () => {
  let dbPath: string

  beforeEach(() => {
    home.path = mkdtempSync(join(tmpdir(), 'dossier-secure-delete-test-'))
    dbPath = join(home.path, 'therascript.db')
    initDatabase(dbPath)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    closeDatabase()
    rmSync(home.path, { recursive: true, force: true })
  })

  function seedDossierWithMarker(service: DossierService): {
    dossierId: string
    sessionId: string
    audioPath: string
  } {
    const result = service.create({
      firstName: 'Hanna',
      lastName: 'Muster',
      externalId: 'PD-4417'
    })
    if (!result.ok) throw new Error('create failed')
    const dossierId = result.dossier.id
    // > eine Seite (4 KiB), damit die Zeile in Overflow-Seiten reicht
    service.update(dossierId, { note: `Notiz ${MARKER} `.repeat(300) })
    service.update(dossierId, { diagnoses: `Diagnose ${MARKER}` })

    const sessions = new SessionService(getDatabase())
    const session = sessions.createSession(`Sitzung ${MARKER}`, 'audio')
    const audioPath = join(home.path, '.therascript', 'audio', `${session.id}.wav`)
    writeFileSync(audioPath, MARKER)
    sessions.updateSession(session.id, { audioPath, summary: `Zusammenfassung ${MARKER}` })
    getDatabase()
      .prepare(
        'INSERT INTO session_dossiers (session_id, dossier_id, assigned_at) VALUES (?, ?, ?)'
      )
      .run(session.id, dossierId, new Date().toISOString())

    // Schwerer Fall: Inhalt in der Datenbankdatei UND eine ältere Fassung im WAL
    getDatabase().pragma('wal_checkpoint(TRUNCATE)')
    service.update(dossierId, { medication: `Medikation ${MARKER}` })
    expect(fileContains(dbPath, MARKER) || fileContains(`${dbPath}-wal`, MARKER)).toBe(true)

    return { dossierId, sessionId: session.id, audioPath }
  }

  // Review #217: ein Dossier OHNE Sitzungen — dann läuft kein Sitzungs-Löschen
  // und damit auch dessen Checkpoint nicht; der Checkpoint in deleteDossier
  // muss die Bytes allein entfernen. Marker in jedem Feld, auch in seiner
  // normalisierten Form (die *_norm-Spalten und ihre Indexe).
  it('leaves no trace of a dossier without sessions, in any field or its normalized form', () => {
    const service = new DossierService(getDatabase())
    const markers = {
      firstName: 'VorQX-Ä-7781',
      lastName: 'NachQX-Ö-7782',
      externalId: 'IDQX-Ü-7783',
      diagnoses: 'DiagQX-7784',
      medication: 'MediQX-7785',
      note: 'NotizQX-7786'
    }
    // Normalisiert gespeichert werden nur Namen und Dossier-ID (*_norm-Spalten)
    const needles = [
      ...Object.values(markers),
      ...[markers.firstName, markers.lastName, markers.externalId].map(normalizeDossierKey)
    ]

    const result = service.create({
      firstName: markers.firstName,
      lastName: markers.lastName,
      externalId: markers.externalId
    })
    if (!result.ok) throw new Error('create failed')
    const id = result.dossier.id
    service.update(id, {
      diagnoses: `Diagnose ${markers.diagnoses}`,
      medication: `Medikation ${markers.medication}`,
      note: `Notiz ${markers.note} `.repeat(300)
    })
    // Inhalt in der Datenbankdatei UND ältere Fassungen im WAL
    getDatabase().pragma('wal_checkpoint(TRUNCATE)')
    service.update(id, {
      firstName: `${markers.firstName}b`,
      lastName: `${markers.lastName}b`,
      externalId: `${markers.externalId}b`,
      diagnoses: `Neu ${markers.diagnoses}`,
      medication: `Neu ${markers.medication}`,
      note: `Neu ${markers.note}`
    })
    const anyFile = (n: string): boolean =>
      fileContains(dbPath, n) || fileContains(`${dbPath}-wal`, n)
    for (const needle of needles) expect(anyFile(needle), needle).toBe(true)

    const { fingerprint } = service.deletePreview(id)!
    expect(service.deleteDossier(id, fingerprint)).toEqual({
      ok: true,
      deletedSessionIds: [],
      incomplete: false
    })

    // Vor closeDatabase prüfen: das Schliessen checkpointet selbst
    for (const needle of needles) {
      expect(fileContains(dbPath, needle), `.db: ${needle}`).toBe(false)
      expect(fileContains(`${dbPath}-wal`, needle), `-wal: ${needle}`).toBe(false)
    }
  })

  it('leaves no trace of the dossier or its exclusive session in .db, -wal or the data dir', () => {
    const service = new DossierService(getDatabase())
    const other = service.create({ firstName: 'Andere', lastName: 'Person' })
    const { dossierId, audioPath } = seedDossierWithMarker(service)

    const { fingerprint } = service.deletePreview(dossierId)!
    expect(service.deleteDossier(dossierId, fingerprint)).toMatchObject({
      ok: true,
      incomplete: false
    })

    expect(fileContains(dbPath, MARKER)).toBe(false)
    expect(fileContains(`${dbPath}-wal`, MARKER)).toBe(false)
    expect(existsSync(audioPath)).toBe(false)
    expect(other.ok && service.get(other.dossier.id)?.lastName).toBe('Person')

    closeDatabase()
    expect(fileContains(dbPath, MARKER)).toBe(false)
    expect(fileContains(`${dbPath}-wal`, MARKER)).toBe(false)
  })

  it('an interrupted deletion is completed by the next start (PC 5)', () => {
    const service = new DossierService(getDatabase())
    const { dossierId, sessionId, audioPath } = seedDossierWithMarker(service)
    const { fingerprint } = service.deletePreview(dossierId)!

    // Absturz nach Phase 1: Phase 2 und der Checkpoint laufen nicht mehr.
    vi.spyOn(SessionService.prototype, 'finishDeletion').mockImplementation(() => {
      throw new Error('simulierter Absturz')
    })
    expect(service.deleteDossier(dossierId, fingerprint)).toMatchObject({
      ok: true,
      incomplete: true
    })
    vi.restoreAllMocks()
    expect(service.get(dossierId)).toBeNull()
    expect(existsSync(audioPath)).toBe(true)

    // Neustart: initDatabase checkpointet, src/main/index.ts schliesst
    // markierte Sitzungen ab (#202).
    closeDatabase()
    initDatabase(dbPath)
    expect(new SessionService(getDatabase()).finishPendingDeletions()).toBe(1)

    expect(getDatabase().prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId)).toBe(
      undefined
    )
    expect(existsSync(audioPath)).toBe(false)
    expect(fileContains(dbPath, MARKER)).toBe(false)
    expect(fileContains(`${dbPath}-wal`, MARKER)).toBe(false)
  })
})
