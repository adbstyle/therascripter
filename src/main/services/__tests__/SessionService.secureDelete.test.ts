import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Issue #202, Postcondition 1: after a confirmed deletion the session must be
// neither findable nor recoverable in the app's files. Runs against a real
// database file with WAL (not :memory:) and searches the raw bytes.

const home = vi.hoisted(() => ({ path: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => home.path }
}))

import { initDatabase, getDatabase, closeDatabase } from '../../db/connection'
import { SessionService } from '../SessionService'
import { applyTestSchema } from '../../db/__tests__/test-utils'
import type { EntityMap } from '../../../shared/types'

const MARKER = 'ZQX-Hans-Muster-Geheimnis-7731'

function bigEntityMap(): EntityMap {
  // > one page (4 KiB), so the row spills into overflow pages
  const map: EntityMap = {}
  for (let i = 0; i < 80; i++) {
    map[`e-${i}`] = {
      original: `${MARKER} Nr. ${i}`,
      placeholder: `[PERSON ${i + 1}]`,
      type: 'PERSON',
      source: 'ner'
    }
  }
  return map
}

function fileContains(path: string, needle: string): boolean {
  if (!existsSync(path)) return false
  return readFileSync(path).includes(Buffer.from(needle, 'utf-8'))
}

describe('SessionService.deleteSession — nothing recoverable on disk', () => {
  let dbPath: string

  beforeEach(() => {
    home.path = mkdtempSync(join(tmpdir(), 'secure-delete-test-'))
    dbPath = join(home.path, 'therascript.db')
    initDatabase(dbPath)
  })

  afterEach(() => {
    closeDatabase()
    rmSync(home.path, { recursive: true, force: true })
  })

  it('leaves no trace of the session in the database file, the WAL or the data dir', () => {
    const service = new SessionService(getDatabase())
    const dataDir = join(home.path, '.therascript')

    const target = service.createSession(`Sitzung ${MARKER}`, 'audio')
    const audioPath = join(dataDir, 'audio', `${target.id}.wav`)
    const anonymizedPath = join(dataDir, 'anonymized', `${target.id}.json`)
    writeFileSync(audioPath, MARKER)
    writeFileSync(anonymizedPath, JSON.stringify({ text: MARKER }))
    service.updateSession(target.id, {
      audioPath,
      anonymizedPath,
      entityMap: bigEntityMap(),
      summary: `Zusammenfassung über ${MARKER}`,
      errorMessage: `Fehler bei ${MARKER}`
    })
    const other = service.createSession('Andere Sitzung', 'pdf')

    // Hard case: the content is in the main database file …
    getDatabase().pragma('wal_checkpoint(TRUNCATE)')
    // … and an older version of the row also sits in the WAL
    service.updateSession(target.id, { summary: `Neue Zusammenfassung ${MARKER}` })
    expect(fileContains(dbPath, MARKER) || fileContains(`${dbPath}-wal`, MARKER)).toBe(true)

    expect(service.deleteSession(target.id)).toBe(true)

    expect(fileContains(dbPath, MARKER)).toBe(false)
    expect(fileContains(`${dbPath}-wal`, MARKER)).toBe(false)
    expect(existsSync(audioPath)).toBe(false)
    expect(existsSync(anonymizedPath)).toBe(false)
    // The other session is untouched
    expect(service.getSession(other.id)?.title).toBe('Andere Sitzung')

    // Still clean after closing (final checkpoint on close)
    closeDatabase()
    expect(fileContains(dbPath, MARKER)).toBe(false)
    expect(fileContains(`${dbPath}-wal`, MARKER)).toBe(false)
  })

  // Control: proves the search above has teeth — without secure_delete and
  // checkpoint, a plain DELETE leaves the content readable in the file.
  it('control: a plain DELETE without secure_delete leaves the content in the file', () => {
    const rawPath = join(home.path, 'control.db')
    const raw = new Database(rawPath)
    raw.pragma('journal_mode = WAL')
    raw.pragma('secure_delete = OFF')
    applyTestSchema(raw)
    raw
      .prepare(
        `INSERT INTO sessions (id, title, type, status, summary, created_at, updated_at)
         VALUES ('c', ?, 'audio', 'review', ?, 'x', 'x')`
      )
      .run(`Sitzung ${MARKER}`, `Zusammenfassung ${MARKER}`)
    raw.pragma('wal_checkpoint(TRUNCATE)')
    raw.prepare("DELETE FROM sessions WHERE id = 'c'").run()
    raw.pragma('wal_checkpoint(TRUNCATE)')
    raw.close()

    expect(fileContains(rawPath, MARKER)).toBe(true)
  })
})
