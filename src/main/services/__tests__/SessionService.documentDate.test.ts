import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({
  app: { getPath: () => '/mock/home' }
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

import { SessionService } from '../SessionService'
import { ReviewService } from '../ReviewService'
import { applyTestSchema } from '../../db/__tests__/test-utils'

/** #205 AK 18–22 — Dokumentdatum eines PDF-Dokuments. */
describe('SessionService.setDocumentDate', () => {
  let db: Database.Database
  let service: SessionService

  function row(id: string): Record<string, unknown> {
    return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown>
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 10, 14, 12, 0))
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    applyTestSchema(db)
    service = new SessionService(db)
    events.sessions = 0
    events.dossiers = 0
  })

  afterEach(() => {
    vi.useRealTimers()
    db.close()
  })

  it('stores the date of a PDF and notifies sessions and dossiers (AK 18)', () => {
    const pdf = service.createSession('Bericht', 'pdf')
    events.sessions = 0
    expect(service.setDocumentDate(pdf.id, '2026-11-02')).toEqual({ ok: true })
    expect(service.getSession(pdf.id)?.documentDate).toBe('2026-11-02')
    expect(events.sessions).toBe(1)
    expect(events.dossiers).toBe(1)
  })

  it('changes a date once set (AK 18) — in every state of the PDF', () => {
    const pdf = service.createSession('Bericht', 'pdf')
    db.prepare("UPDATE sessions SET status = 'error' WHERE id = ?").run(pdf.id)
    service.setDocumentDate(pdf.id, '2026-11-02')
    expect(service.setDocumentDate(pdf.id, '2025-01-31')).toEqual({ ok: true })
    expect(service.getSession(pdf.id)?.documentDate).toBe('2025-01-31')
  })

  it('leaves a new PDF without document date — the import date counts (AK 19)', () => {
    const pdf = service.createSession('Bericht', 'pdf')
    expect(service.getSession(pdf.id)?.documentDate).toBeNull()
  })

  it('rejects recordings and unknown sessions without changing anything (PC 3)', () => {
    const audio = service.createSession('Aufnahme', 'audio')
    const before = row(audio.id)
    expect(service.setDocumentDate(audio.id, '2026-11-02')).toEqual({
      ok: false,
      reason: 'not-pdf'
    })
    expect(row(audio.id)).toEqual(before)
    expect(service.setDocumentDate('missing', '2026-11-02')).toEqual({
      ok: false,
      reason: 'not-found'
    })
  })

  it('rejects a PDF that is being deleted', () => {
    const pdf = service.createSession('Bericht', 'pdf')
    db.prepare('UPDATE sessions SET deleting_at = ? WHERE id = ?').run('2026-11-14', pdf.id)
    expect(service.setDocumentDate(pdf.id, '2026-11-02')).toEqual({
      ok: false,
      reason: 'not-found'
    })
    expect(row(pdf.id).document_date).toBeNull()
  })

  it('throws on a future or impossible date and keeps the previous one (AK 21, PC 3)', () => {
    const pdf = service.createSession('Bericht', 'pdf')
    service.setDocumentDate(pdf.id, '2026-11-02')
    expect(() => service.setDocumentDate(pdf.id, '2026-11-15')).toThrow()
    expect(() => service.setDocumentDate(pdf.id, '2026-02-30')).toThrow()
    expect(() => service.setDocumentDate(pdf.id, '')).toThrow()
    expect(service.getSession(pdf.id)?.documentDate).toBe('2026-11-02')
  })

  it('accepts today in local time', () => {
    const pdf = service.createSession('Bericht', 'pdf')
    expect(service.setDocumentDate(pdf.id, '2026-11-14')).toEqual({ ok: true })
  })

  it('touches neither title, summary nor pseudonymization (PC 2)', () => {
    const pdf = service.createSession('Bericht über [PERSON 1]', 'pdf')
    db.prepare('UPDATE sessions SET summary = ?, entity_map = ? WHERE id = ?').run(
      'Zusammenfassung',
      '{"person-1":{"original":"Ruth"}}',
      pdf.id
    )
    const before = row(pdf.id)
    service.setDocumentDate(pdf.id, '2026-11-02')
    const after = row(pdf.id)
    expect({ ...after, document_date: null, updated_at: null }).toEqual({
      ...before,
      document_date: null,
      updated_at: null
    })
  })

  it('is part of review:load together with the import time (AK 20)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'document-date-'))
    try {
      const docPath = join(dir, 'doc.json')
      writeFileSync(docPath, JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] }))
      const pdf = service.createSession('Bericht', 'pdf')
      db.prepare("UPDATE sessions SET status = 'review', anonymized_path = ? WHERE id = ?").run(
        docPath,
        pdf.id
      )
      const review = new ReviewService(db)
      expect(review.load(pdf.id)).toMatchObject({ documentDate: null, createdAt: pdf.createdAt })
      service.setDocumentDate(pdf.id, '2026-11-02')
      expect(review.load(pdf.id).documentDate).toBe('2026-11-02')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
