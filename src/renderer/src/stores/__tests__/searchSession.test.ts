import { describe, it, expect, beforeEach } from 'vitest'
import {
  _resetSearchSessionForTests,
  beginSearchRequest,
  getSearchEntry,
  isLatestSearchRequest,
  mergeSemanticResult,
  purgeDeletedDossiers,
  purgeDeletedSessions,
  updateSearchEntry
} from '../searchSession'
import {
  answer,
  doc,
  DOSSIER_HOFER_LUKAS,
  DOSSIER_HOFER_LUKAS_2
} from '../../components/search/__tests__/searchFixtures'

beforeEach(() => _resetSearchSessionForTests())

describe('searchSession', () => {
  it('erkennt überholte Anfragen je Suche', () => {
    const a = beginSearchRequest('all')
    const d = beginSearchRequest('dossier:d1')
    const b = beginSearchRequest('all')
    expect(isLatestSearchRequest('all', a)).toBe(false)
    expect(isLatestSearchRequest('all', b)).toBe(true)
    expect(isLatestSearchRequest('dossier:d1', d)).toBe(true)
  })

  it('hängt Treffer nach Bedeutung an, wenn die Reihenfolge bleiben soll', () => {
    const shown = answer(1, { results: [doc('s1'), doc('s2')] })
    const next = answer(1, { results: [doc('s3'), doc('s2'), doc('s1')], truncated: true })
    expect(mergeSemanticResult(shown, next, false)).toBe(next)
    const kept = mergeSemanticResult(shown, next, true)
    expect(kept.results.map((r) => r.sessionId)).toEqual(['s1', 's2', 's3'])
    expect(kept.truncated).toBe(true)
  })

  it('entfernt gelöschte Sitzungen aus allen Suchen', () => {
    updateSearchEntry('all', { result: answer(1, { results: [doc('s1'), doc('s2')] }) })
    updateSearchEntry('dossier:d1', { result: answer(2, { results: [doc('s1')] }) })
    purgeDeletedSessions(['s1'])
    expect(getSearchEntry('all').result!.results.map((r) => r.sessionId)).toEqual(['s2'])
    expect(getSearchEntry('dossier:d1').result!.results).toEqual([])
  })

  it('ein gelöschtes Dossier setzt jede Suche zurück, deren Treffer es enthielten', () => {
    updateSearchEntry('all', {
      query: 'Angst',
      submitted: 'Angst',
      result: answer(1, {
        results: [doc('s1', { dossiers: [DOSSIER_HOFER_LUKAS, DOSSIER_HOFER_LUKAS_2] })]
      })
    })
    updateSearchEntry(`dossier:${DOSSIER_HOFER_LUKAS.id}`, { submitted: 'Angst' })
    updateSearchEntry('dossier:andere', {
      query: 'Brändli',
      submitted: 'Brändli',
      result: answer(2, { results: [doc('s9', { dossiers: [] })] })
    })
    purgeDeletedDossiers([DOSSIER_HOFER_LUKAS.id])
    expect(getSearchEntry('all').submitted).toBeNull()
    expect(getSearchEntry('all').query).toBe('')
    expect(getSearchEntry(`dossier:${DOSSIER_HOFER_LUKAS.id}`).submitted).toBeNull()
    expect(getSearchEntry('dossier:andere').submitted).toBe('Brändli')
  })

  it('verwirft auch Anfragen mit Namen oder ID eines gelöschten Dossiers (wie #209 PC 4)', () => {
    // Das Dossier kam in einer früher angezeigten Antwort vor
    updateSearchEntry('dossier:x', {
      result: answer(1, { dossiers: [DOSSIER_HOFER_LUKAS] })
    })
    updateSearchEntry('dossier:x', { result: null, submitted: null })
    updateSearchEntry('dossier:andere', { query: 'hofer schlaf', submitted: 'hofer schlaf' })
    updateSearchEntry('dossier:dritte', { query: 'pd-1188', submitted: 'pd-1188' })
    updateSearchEntry('dossier:vierte', { query: 'Schlaf', submitted: 'Schlaf' })
    purgeDeletedDossiers([DOSSIER_HOFER_LUKAS.id])
    expect(getSearchEntry('dossier:andere').submitted).toBeNull()
    expect(getSearchEntry('dossier:dritte').submitted).toBeNull()
    expect(getSearchEntry('dossier:vierte').submitted).toBe('Schlaf')
  })

  it('ersetzt bekannte Dokumente durch die Fassung der zweiten Antwort, auch bei fester Reihenfolge', () => {
    const shown = answer(1, { results: [doc('s1', { hits: [] }), doc('s2')] })
    const fresh = doc('s1')
    const next = answer(1, { results: [doc('s3'), doc('s2'), fresh] })
    const kept = mergeSemanticResult(shown, next, true)
    expect(kept.results[0]).toBe(fresh)
  })
})
