import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { SessionService } from '../SessionService'
import { applyTestSchema } from '../../db/__tests__/test-utils'
import { backfillPlainTexts } from '../../db/plainTexts'
import type { EntityMap, PlaceholderType } from '../../../shared/types'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/mock/home') }
}))

function entry(placeholder: string, original: string, type: PlaceholderType = 'PERSON') {
  return { placeholder, original, type, source: 'ner' as const }
}

const MAP: EntityMap = {
  'person-1': entry('[PERSON 1]', 'Ruth Gerber'),
  'ort-1': entry('[ORT 1]', 'Bern', 'ORT')
}

/**
 * Issue #203 — Klartext title/summary: the meaning of each token is recorded
 * when the text is written; the list and the editor resolve only tokens
 * whose meaning is unchanged since (AK 4, AK 5).
 */
describe('SessionService — placeholder snapshots (#203)', () => {
  let db: Database.Database
  let service: SessionService

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    applyTestSchema(db)
    service = new SessionService(db)
  })

  afterEach(() => db.close())

  function summarizedSession(map: EntityMap = MAP): string {
    const session = service.createSession('Aufnahme 14.02.2026', 'audio')
    service.updateSession(session.id, { entityMap: map })
    service.saveGeneratedSummary(
      session.id,
      'Gespräch mit [PERSON 1]',
      '[PERSON 1] aus [ORT 1] erzählt.',
      'gemma'
    )
    return session.id
  }

  it('resolves title and summary in the list and the detail read', () => {
    const id = summarizedSession()

    const [listed] = service.getAllSessions()
    expect(listed.entityMap).toBeNull() // the list still never ships the EntityMap
    expect(listed.title).toBe('Gespräch mit [PERSON 1]')
    expect(listed.titlePlain).toBe('Gespräch mit Ruth Gerber')
    expect(listed.summary).toBe('[PERSON 1] aus [ORT 1] erzählt.')
    expect(listed.summaryPlain).toBe('Ruth Gerber aus Bern erzählt.')

    const detail = service.getSession(id)!
    expect(detail.titlePlain).toBe('Gespräch mit Ruth Gerber')
    expect(detail.summaryPlain).toBe('Ruth Gerber aus Bern erzählt.')
  })

  it('keeps a token whose meaning changed after the summary was written (AK 5)', () => {
    const id = summarizedSession()
    // The user changed [ORT 1]'s type; the number now denotes someone else
    service.updateSession(id, {
      entityMap: {
        'person-1': entry('[PERSON 1]', 'Ruth Gerber'),
        'ort-1': entry('[ORT 1]', 'Thun', 'ORT')
      }
    })

    const [listed] = service.getAllSessions()
    expect(listed.summaryPlain).toBe('Ruth Gerber aus [ORT 1] erzählt.')
  })

  it('records the EntityMap the summarization read, not the one at save time', () => {
    const session = service.createSession('Aufnahme', 'audio')
    service.updateSession(session.id, {
      entityMap: { 'person-1': entry('[PERSON 1]', 'Max Muster') }
    })
    service.saveGeneratedSummary(session.id, 'T', 'Mit [PERSON 1].', 'gemma', MAP)
    expect(service.getSession(session.id)!.summaryEntitySnapshot).toEqual({
      '[PERSON 1]': 'Ruth Gerber'
    })
    expect(service.getSession(session.id)!.summaryPlain).toBe('Mit [PERSON 1].')
  })

  it('getSummary returns the snapshots for the editor', () => {
    const id = summarizedSession()
    const record = service.getSummary(id)!
    expect(record.titleSnapshot).toEqual({ '[PERSON 1]': 'Ruth Gerber' })
    expect(record.textSnapshot).toEqual({ '[PERSON 1]': 'Ruth Gerber', '[ORT 1]': 'Bern' })
  })

  it('a user edit keeps recorded meanings and records newly typed tokens', () => {
    const id = summarizedSession()
    service.updateSession(id, {
      entityMap: {
        'person-1': entry('[PERSON 1]', 'Max Muster'),
        'ort-1': entry('[ORT 1]', 'Bern', 'ORT'),
        'person-2': entry('[PERSON 2]', 'Lea Keller')
      }
    })

    service.updateSummaryText(id, '[PERSON 1] und [PERSON 2] aus [ORT 1].')
    service.updateTitle(id, '  [PERSON 2]  ')

    const session = service.getSession(id)!
    expect(session.summaryEntitySnapshot).toEqual({
      '[PERSON 1]': 'Ruth Gerber',
      '[ORT 1]': 'Bern',
      '[PERSON 2]': 'Lea Keller'
    })
    expect(session.summaryPlain).toBe('[PERSON 1] und Lea Keller aus Bern.')
    expect(session.title).toBe('[PERSON 2]')
    expect(session.titlePlain).toBe('Lea Keller')
  })

  it('clearing the summary drops its snapshot', () => {
    const id = summarizedSession()
    service.updateSummaryText(id, '   ')
    expect(service.getSession(id)!.summaryEntitySnapshot).toBeNull()
  })

  it('sessions without tokens resolve to their plain texts unchanged', () => {
    const session = service.createSession('Aufnahme 14.02.2026', 'audio')
    const [listed] = service.getAllSessions()
    expect(listed.id).toBe(session.id)
    expect(listed.titlePlain).toBe('Aufnahme 14.02.2026')
    expect(listed.summaryPlain).toBeNull()
  })

  it('an edit leaves tokens of the old text without record unresolved (review case, AK 5)', () => {
    const session = service.createSession('Aufnahme', 'audio')
    // At creation [PERSON 2] is ambiguous and [PERSON 3] hallucinated
    service.updateSession(session.id, {
      entityMap: {
        a: entry('[PERSON 2]', 'Max'),
        b: entry('[PERSON 2]', 'Moritz')
      }
    })
    service.saveGeneratedSummary(session.id, 'T', '[PERSON 2] traf [PERSON 3].', 'gemma')
    // Later both numbers are unambiguous — but they did not mean that then
    service.updateSession(session.id, {
      entityMap: { a: entry('[PERSON 2]', 'Max'), c: entry('[PERSON 3]', 'Lea Keller') }
    })
    service.updateSummaryText(session.id, '[PERSON 2] traf [PERSON 3] gestern.')

    const [listed] = service.getAllSessions()
    expect(listed.summaryPlain).toBe('[PERSON 2] traf [PERSON 3] gestern.')
  })

  it('the stored Klartext follows a later EntityMap change (review:save path)', () => {
    const id = summarizedSession()
    service.updateSession(id, {
      entityMap: {
        'person-1': entry('[PERSON 1]', 'Max Muster'),
        'ort-1': entry('[ORT 1]', 'Bern', 'ORT')
      }
    })
    const [listed] = service.getAllSessions()
    expect(listed.titlePlain).toBe('Gespräch mit [PERSON 1]')
    expect(listed.summaryPlain).toBe('[PERSON 1] aus Bern erzählt.')
  })

  it('the list carries only resolved strings — no EntityMap, no snapshots', () => {
    summarizedSession()
    const [listed] = service.getAllSessions()
    expect(listed.entityMap).toBeNull()
    expect(listed.titleEntitySnapshot).toBeNull()
    expect(listed.summaryEntitySnapshot).toBeNull()
  })

  it('findAll parses no JSON, even for 2000 sessions with 150 entities each (NFR 3)', () => {
    const map: EntityMap = {}
    for (let i = 1; i <= 150; i++) map[`person-${i}`] = entry(`[PERSON ${i}]`, `Name ${i}`)
    const mapJson = JSON.stringify(map)
    const snapshot = JSON.stringify({ '[PERSON 1]': 'Name 1', '[PERSON 150]': 'Name 150' })
    const insert = db.prepare(
      `INSERT INTO sessions (id, title, type, status, summary, entity_map,
         title_entity_snapshot, summary_entity_snapshot, created_at, updated_at)
       VALUES (?, '[PERSON 1]', 'audio', 'review', '[PERSON 1] und [PERSON 150]', ?, ?, ?, ?, ?)`
    )
    db.transaction(() => {
      for (let i = 0; i < 2000; i++) {
        const at = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()
        insert.run(`s${i}`, mapJson, snapshot, snapshot, at, at)
      }
    })()
    expect(backfillPlainTexts(db)).toBe(2000)

    const parse = vi.spyOn(JSON, 'parse')
    const started = performance.now()
    const sessions = service.getAllSessions()
    const elapsed = performance.now() - started
    const parseCalls = parse.mock.calls.length
    parse.mockRestore()

    expect(sessions).toHaveLength(2000)
    expect(sessions[0].titlePlain).toBe('Name 1')
    expect(sessions[0].summaryPlain).toBe('Name 1 und Name 150')
    expect(parseCalls).toBe(0)
    expect(elapsed).toBeLessThan(1000)
  })

  it('deleting scrubs snapshots and Klartext with the content (#202 two-phase delete)', () => {
    const id = summarizedSession()
    const repo = (
      service as unknown as {
        repository: { markDeleting(id: string): boolean; scrubMarkedContent(id: string): void }
      }
    ).repository
    repo.markDeleting(id)
    repo.scrubMarkedContent(id)
    const row = db
      .prepare(
        `SELECT title_entity_snapshot, summary_entity_snapshot, title_plain, summary_plain
         FROM sessions WHERE id = ?`
      )
      .get(id)
    expect(row).toEqual({
      title_entity_snapshot: null,
      summary_entity_snapshot: null,
      title_plain: null,
      summary_plain: null
    })
  })
})
