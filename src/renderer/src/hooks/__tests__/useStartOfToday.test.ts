import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { startOfDay, useStartOfToday } from '../useStartOfToday'

afterEach(() => {
  vi.useRealTimers()
})

describe('useStartOfToday', () => {
  it('liefert den Tagesbeginn und wechselt kurz nach Mitternacht', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 11, 23, 59, 30))
    const { result } = renderHook(() => useStartOfToday())
    expect(result.current).toBe(new Date(2026, 9, 11).getTime())

    act(() => vi.advanceTimersByTime(60_000))
    expect(result.current).toBe(new Date(2026, 9, 12).getTime())
  })

  it('rendert innerhalb desselben Tags nicht neu', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 11, 10, 0))
    let renders = 0
    renderHook(() => {
      renders++
      return useStartOfToday()
    })

    act(() => vi.advanceTimersByTime(10 * 60_000))
    expect(renders).toBe(1)
  })
})

describe('startOfDay', () => {
  it('schneidet die Uhrzeit ab', () => {
    expect(startOfDay(new Date(2026, 9, 11, 14, 2, 5))).toBe(new Date(2026, 9, 11).getTime())
  })
})
