import { Profiler } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { SaveStatus } from '../SaveStatus'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 9, 11, 9, 0, 0))
})

afterEach(() => {
  vi.useRealTimers()
})

// Der memoisierte ReviewEditor rendert nicht periodisch — das Label muss
// selbst weiterlaufen (Issue #140).
describe('SaveStatus', () => {
  it('rendert nicht, solange "gerade eben" gilt, und zählt danach sekündlich hoch', () => {
    const onRender = vi.fn()
    render(
      <Profiler id="save-status" onRender={onRender}>
        <SaveStatus saving={false} lastSavedAt={Date.now()} />
      </Profiler>
    )
    expect(screen.getByText('Gespeichert gerade eben')).toBeInTheDocument()
    onRender.mockClear()

    act(() => vi.advanceTimersByTime(4_999))
    expect(onRender).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(1))
    expect(screen.getByText('Gespeichert vor 5s')).toBeInTheDocument()

    act(() => vi.advanceTimersByTime(7_000))
    expect(screen.getByText('Gespeichert vor 12s')).toBeInTheDocument()
  })

  it('rendert nach der ersten Minute nur noch zum Minutenwechsel', () => {
    const onRender = vi.fn()
    render(
      <Profiler id="save-status" onRender={onRender}>
        <SaveStatus saving={false} lastSavedAt={Date.now()} />
      </Profiler>
    )
    act(() => vi.advanceTimersByTime(60_000))
    expect(screen.getByText('Gespeichert vor 1 Min')).toBeInTheDocument()
    onRender.mockClear()

    act(() => vi.advanceTimersByTime(59_000))
    expect(onRender).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(1_000))
    expect(screen.getByText('Gespeichert vor 2 Min')).toBeInTheDocument()
    expect(onRender).toHaveBeenCalledTimes(1)
  })

  it('zeigt den Speichervorgang ohne Takt', () => {
    render(<SaveStatus saving lastSavedAt={Date.now()} />)
    expect(screen.getByText('Speichern...')).toBeInTheDocument()
    expect(vi.getTimerCount()).toBe(0)
  })
})
