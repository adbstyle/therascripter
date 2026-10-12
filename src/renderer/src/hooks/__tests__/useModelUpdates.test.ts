import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useModelUpdates } from '../useModelUpdates'
import type { PendingModelUpdate } from '../../../../shared/types/ModelUpdate'

const update = (id: string): PendingModelUpdate => ({
  id,
  version: '2026-10-12',
  label: id,
  url: `https://example.com/${id}`,
  sha256: 'c'.repeat(64),
  sizeBytes: 100,
  relativePath: `asr/${id}.bin`,
  archive: false,
  checkPath: `asr/${id}.bin`
})

let push: (updates: PendingModelUpdate[]) => void
const getAvailable = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  window.api = {
    modelUpdate: {
      getAvailable,
      onAvailable: (cb: typeof push) => {
        push = cb
        return () => {}
      }
    }
  } as unknown as typeof window.api
})

describe('useModelUpdates (#144)', () => {
  it('übernimmt beim Mount den Stand aus dem Main-Prozess', async () => {
    getAvailable.mockResolvedValue([update('whisper')])
    const { result } = renderHook(() => useModelUpdates())
    await waitFor(() => expect(result.current.availableUpdates).toEqual([update('whisper')]))
  })

  it('ein späterer Push überschreibt den Stand — auch eine leere Liste', async () => {
    getAvailable.mockResolvedValue([update('whisper')])
    const { result } = renderHook(() => useModelUpdates())
    await waitFor(() => expect(result.current.availableUpdates).not.toBeNull())
    act(() => push([]))
    expect(result.current.availableUpdates).toBeNull()
  })

  it('ein Push während des Abholens gewinnt gegen die ältere Antwort', async () => {
    let resolve: (u: PendingModelUpdate[]) => void = () => undefined
    getAvailable.mockReturnValue(new Promise((r) => (resolve = r)))
    const { result } = renderHook(() => useModelUpdates())
    act(() => push([update('pyannote')]))
    await act(async () => resolve([update('whisper')]))
    expect(result.current.availableUpdates).toEqual([update('pyannote')])
  })
})
