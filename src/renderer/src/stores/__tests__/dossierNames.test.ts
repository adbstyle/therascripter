import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import {
  _resetDossierNamesForTests,
  getAmbiguousDossierNames,
  useAmbiguousDossierNames
} from '../dossierNames'
import { createMockApi } from '../../test/mockApi'
import { makeDossierListItem } from '../../test/dossierFixtures'

afterEach(() => _resetDossierNamesForTests())

describe('stores/dossierNames', () => {
  it('hält die normalisierten mehrfach vergebenen Namen und leert sie beim letzten Abmelden', async () => {
    window.api = createMockApi({
      dossiers: {
        list: vi
          .fn()
          .mockResolvedValue([
            makeDossierListItem({ id: 'a', firstName: 'Lukas', lastName: 'Hofer' }),
            makeDossierListItem({ id: 'b', firstName: 'Lukas', lastName: 'Hofer' }),
            makeDossierListItem({ id: 'c', firstName: 'Anna', lastName: 'Keller' })
          ])
      }
    })
    const { result, unmount } = renderHook(() => useAmbiguousDossierNames())
    await waitFor(() => expect(result.current.size).toBe(1))
    expect([...result.current][0]).toBe('hofer\u0000lukas')
    unmount()
    expect(getAmbiguousDossierNames().size).toBe(0)
  })
})
