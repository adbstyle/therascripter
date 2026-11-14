import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { SessionService } from '../SessionService'
import { applyTestSchema } from '../../db/__tests__/test-utils'
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
})
