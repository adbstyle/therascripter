import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import {
  SearchRecentRepository,
  forgetKeys,
  recentQueryKey
} from '../../db/repositories/SearchRecentRepository'
import { DossierService } from '../../services/DossierService'
import { createSearchTestDb } from './helpers'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/mock/home') },
  BrowserWindow: { getAllWindows: () => [] }
}))

describe('SearchRecentRepository — five last searches (#209 AK 27/28)', () => {
  let db: Database.Database
  let recent: SearchRecentRepository

  beforeEach(() => {
    db = createSearchTestDb()
    recent = new SearchRecentRepository(db)
  })

  afterEach(() => db.close())

  const queries = (): string[] => recent.list().map((r) => r.query)

  it('keeps at most five, newest first, deduplicated by the normalized query', () => {
    const t = Date.parse('2026-06-01T10:00:00.000Z')
    ;['eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs'].forEach((q, i) =>
      recent.remember(q, new Date(t + i * 1000))
    )
    expect(queries()).toEqual(['sechs', 'fünf', 'vier', 'drei', 'zwei'])
    recent.remember('  FUENF ', new Date(t + 10_000))
    expect(queries()).toEqual(['FUENF', 'sechs', 'vier', 'drei', 'zwei'])
    expect(db.prepare('SELECT COUNT(*) AS n FROM search_recent_queries').get()).toEqual({ n: 5 })
  })

  it('orders strictly even within the same millisecond and ignores blank queries', () => {
    const now = new Date('2026-06-01T10:00:00.000Z')
    recent.remember('a', now)
    recent.remember('b', now)
    recent.remember('a', now)
    recent.remember('   ', now)
    expect(queries()).toEqual(['a', 'b'])
  })

  it('survives a restart (#209 PC 2) and can be cleared (#209 AK 28)', () => {
    recent.remember('Angst')
    expect(new SearchRecentRepository(db).list().map((r) => r.query)).toEqual(['Angst'])
    recent.clear()
    expect(queries()).toEqual([])
  })

  it('splits dossier names into words for the removal (#209 PC 4)', () => {
    expect(forgetKeys(['Müller-Lüdenscheidt', 'Anna Lena'], ['PD-7'])).toEqual([
      'mueller-luedenscheidt',
      'mueller',
      'luedenscheidt',
      'anna lena',
      'anna',
      'lena',
      'pd-7'
    ])
    recent.remember('müller')
    recent.remember('lena schlaf')
    recent.remember('Angst')
    recent.forgetContaining(['Müller-Lüdenscheidt', 'Anna Lena'], [null])
    expect(queries()).toEqual(['Angst'])
  })

  it('normalizes the dedup key like the search', () => {
    expect(recentQueryKey(' Müller   Anna ')).toBe('mueller anna')
  })

  it('removes queries naming a deleted dossier, and only those (#209 PC 4)', () => {
    const dossiers = new DossierService(db)
    const created = dossiers.create({
      firstName: 'Jürg',
      lastName: 'Zimmerli',
      externalId: 'PD-77'
    })
    if (!created.ok) throw new Error('create')
    recent.remember('juerg schlaf')
    recent.remember('ZIMMERLI')
    recent.remember('pd-77 bericht')
    recent.remember('Prüfungsangst')
    const { fingerprint } = dossiers.deletePreview(created.dossier.id)!
    expect(dossiers.deleteDossier(created.dossier.id, fingerprint)).toMatchObject({ ok: true })
    expect(queries()).toEqual(['Prüfungsangst'])
  })
})
