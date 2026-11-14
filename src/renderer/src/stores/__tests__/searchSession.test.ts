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

  it('ein gelöschtes Dossier beendet seine Suche und verschwindet aus Treffern und Plaketten', () => {
    updateSearchEntry('all', {
      submitted: 'Hofer',
      result: answer(1, {
        dossiers: [DOSSIER_HOFER_LUKAS, DOSSIER_HOFER_LUKAS_2],
        results: [doc('s1', { dossiers: [DOSSIER_HOFER_LUKAS, DOSSIER_HOFER_LUKAS_2] })]
      })
    })
    updateSearchEntry(`dossier:${DOSSIER_HOFER_LUKAS.id}`, { submitted: 'Angst' })
    purgeDeletedDossiers([DOSSIER_HOFER_LUKAS.id])
    const all = getSearchEntry('all').result!
    expect(all.dossiers.map((d) => d.id)).toEqual([DOSSIER_HOFER_LUKAS_2.id])
    expect(all.results[0].dossiers.map((d) => d.id)).toEqual([DOSSIER_HOFER_LUKAS_2.id])
    expect(getSearchEntry(`dossier:${DOSSIER_HOFER_LUKAS.id}`).submitted).toBeNull()
  })
})
