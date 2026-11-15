import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// #205 Postcondition 5: Nach dem Lösen einer Zuordnung ist die Zuordnung in
// den Dateien der App nicht mehr auffindbar — weder in der Datenbankdatei
// noch im WAL. Sitzung und Dossier bestehen weiter, ihre IDs stehen also
// zu Recht noch in den Dateien; geprüft wird deshalb nur, was allein die
// Zuordnungszeile trägt:
//   - die Zeile in session_dossiers (WITHOUT ROWID: session_id, dossier_id,
//     assigned_at hintereinander) — Sitzungs-ID direkt gefolgt von der
//     Dossier-ID, und ein eindeutiger Zeitstempel als assigned_at
//   - der Eintrag im Index idx_session_dossiers_dossier (dossier_id,
//     session_id) — Dossier-ID direkt gefolgt von der Sitzungs-ID
// Echte Datenbankdatei mit WAL, Suche in den Rohbytes wie in
// DossierService.secureDelete.test.ts.

const home = vi.hoisted(() => ({ path: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => home.path },
  BrowserWindow: { getAllWindows: () => [] }
}))

import { initDatabase, getDatabase, closeDatabase } from '../../db/connection'
import { DossierService } from '../DossierService'
import { SessionService } from '../SessionService'
import { SessionDossierService } from '../SessionDossierService'

/** Ein Zeitpunkt, der sonst nirgends in der Datenbank vorkommt. */
const ASSIGNED_AT = new Date('2031-07-19T04:17:53.917Z')

function fileContains(path: string, needle: string): boolean {
  if (!existsSync(path)) return false
  return readFileSync(path).includes(Buffer.from(needle, 'utf-8'))
}

describe('SessionDossierService.unassign — the assignment leaves no trace on disk (#205 PC 5)', () => {
  let dbPath: string

  beforeEach(() => {
    home.path = mkdtempSync(join(tmpdir(), 'unassign-secure-delete-test-'))
    dbPath = join(home.path, 'therascript.db')
    initDatabase(dbPath)
  })

  afterEach(() => {
    vi.useRealTimers()
    closeDatabase()
    rmSync(home.path, { recursive: true, force: true })
  })

  const anyFile = (needle: string): boolean =>
    fileContains(dbPath, needle) || fileContains(`${dbPath}-wal`, needle)

  it.each([
    ['in der Datenbankdatei (nach einem Checkpoint)', true],
    ['nur im WAL (noch kein Checkpoint)', false]
  ])('Zuordnung %s: nach dem Lösen weg, Sitzung und Dossier bleiben', (_label, checkpoint) => {
    const db = getDatabase()
    const dossiers = new DossierService(db)
    const created = dossiers.create({ firstName: 'Lösen', lastName: 'Test' })
    if (!created.ok) throw new Error('create failed')
    const dossierId = created.dossier.id
    const sessionId = new SessionService(db).createSession('Sitzung', 'audio').id
    // Eine zweite Zuordnung derselben Sitzung bleibt bestehen — das Lösen
    // trifft nur die eine Zeile
    const other = dossiers.create({ firstName: 'Bleibt', lastName: 'Zugeordnet' })
    if (!other.ok) throw new Error('create failed')

    const service = new SessionDossierService(db)
    vi.useFakeTimers({ toFake: ['Date'], now: ASSIGNED_AT })
    expect(service.assign(sessionId, dossierId)).toEqual({ ok: true })
    vi.useRealTimers()
    expect(service.assign(sessionId, other.dossier.id)).toEqual({ ok: true })
    if (checkpoint) db.pragma('wal_checkpoint(TRUNCATE)')

    const needles = {
      'Zeile (session_id, dossier_id)': sessionId + dossierId,
      'Index (dossier_id, session_id)': dossierId + sessionId,
      assigned_at: ASSIGNED_AT.toISOString()
    }
    // Vorbedingung: die Prüfung findet die Zuordnung, solange sie besteht
    for (const [what, needle] of Object.entries(needles)) {
      expect(anyFile(needle), `vorher: ${what}`).toBe(true)
    }

    expect(service.unassign(sessionId, dossierId)).toEqual({ ok: true })

    // Vor closeDatabase prüfen: das Schliessen checkpointet selbst
    for (const [what, needle] of Object.entries(needles)) {
      expect(fileContains(dbPath, needle), `.db: ${what}`).toBe(false)
      expect(fileContains(`${dbPath}-wal`, needle), `-wal: ${what}`).toBe(false)
    }
    // Sitzung, Dossier und die andere Zuordnung bestehen weiter
    expect(anyFile(sessionId)).toBe(true)
    expect(anyFile(dossierId)).toBe(true)
    expect(anyFile(sessionId + other.dossier.id)).toBe(true)
    expect(
      db.prepare('SELECT dossier_id FROM session_dossiers WHERE session_id = ?').all(sessionId)
    ).toEqual([{ dossier_id: other.dossier.id }])
  })
})
