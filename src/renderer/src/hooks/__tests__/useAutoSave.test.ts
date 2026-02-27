import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useAutoSave } from '../useAutoSave'

describe('useAutoSave', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns initial state with saving=false and lastSavedAt=null', () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() => useAutoSave(onSave, [0], 2000))

    expect(result.current.saving).toBe(false)
    expect(result.current.lastSavedAt).toBeNull()
  })

  it('does not save on first render', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    renderHook(() => useAutoSave(onSave, [0], 2000))

    await act(async () => {
      vi.advanceTimersByTime(3000)
    })

    expect(onSave).not.toHaveBeenCalled()
  })

  it('saves after dependency change and delay', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    let counter = 0
    const { rerender } = renderHook(() => useAutoSave(onSave, [counter], 2000))

    // Change dependency
    counter = 1
    rerender()

    // Wait for debounce
    await act(async () => {
      vi.advanceTimersByTime(2000)
    })

    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('debounces rapid changes', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    let counter = 0
    const { rerender } = renderHook(() => useAutoSave(onSave, [counter], 2000))

    // Multiple rapid changes
    counter = 1
    rerender()
    await act(async () => {
      vi.advanceTimersByTime(500)
    })

    counter = 2
    rerender()
    await act(async () => {
      vi.advanceTimersByTime(500)
    })

    counter = 3
    rerender()

    // Wait for debounce
    await act(async () => {
      vi.advanceTimersByTime(2000)
    })

    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('does not save when onSave is null', async () => {
    let counter = 0
    const { rerender } = renderHook(() => useAutoSave(null, [counter], 2000))

    counter = 1
    rerender()

    await act(async () => {
      vi.advanceTimersByTime(3000)
    })

    // No error thrown, nothing called
    expect(true).toBe(true)
  })

  it('handles save error gracefully', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const onSave = vi.fn().mockRejectedValue(new Error('Save failed'))
    let counter = 0
    const { result, rerender } = renderHook(() => useAutoSave(onSave, [counter], 2000))

    counter = 1
    rerender()

    await act(async () => {
      vi.advanceTimersByTime(2000)
    })

    expect(onSave).toHaveBeenCalledTimes(1)
    expect(result.current.saving).toBe(false)
    consoleSpy.mockRestore()
  })
})
