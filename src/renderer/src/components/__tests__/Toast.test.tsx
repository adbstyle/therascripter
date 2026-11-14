import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { Toast, type ToastData } from '../Toast'

/** Review #225 — Hinweise mit Handlungsanweisung bleiben lesbar und erreichbar. */

function renderToast(toast: Partial<ToastData> = {}) {
  const onDismiss = vi.fn()
  render(
    <Toast toast={{ id: 1, message: 'Meldung', type: 'error', ...toast }} onDismiss={onDismiss} />
  )
  return { onDismiss, box: screen.getByRole('status') }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('Toast', () => {
  it('Erfolgs-Hinweis: ohne Schliessen-Knopf, verschwindet nach 3 s auch unter der Maus', () => {
    const { onDismiss, box } = renderToast({ type: 'success' })
    expect(screen.queryByRole('button')).toBeNull()
    fireEvent.mouseEnter(box)
    act(() => vi.advanceTimersByTime(3200))
    expect(onDismiss).toHaveBeenCalledWith(1)
  })

  it('Fehler-Hinweis: bleibt, solange die Maus darauf liegt, und läuft danach weiter', () => {
    const { onDismiss, box } = renderToast({ durationMs: 10_000 })
    act(() => vi.advanceTimersByTime(4000))
    fireEvent.mouseEnter(box)
    act(() => vi.advanceTimersByTime(60_000))
    expect(onDismiss).not.toHaveBeenCalled()
    fireEvent.mouseLeave(box)
    act(() => vi.advanceTimersByTime(5900))
    expect(onDismiss).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(400))
    expect(onDismiss).toHaveBeenCalledWith(1)
  })

  it('Fehler-Hinweis: bleibt, solange der Tastaturfokus darauf liegt; Schliessen-Knopf mit Namen', () => {
    const { onDismiss } = renderToast()
    const close = screen.getByRole('button', { name: 'Meldung schliessen' })
    act(() => close.focus())
    act(() => vi.advanceTimersByTime(30_000))
    expect(onDismiss).not.toHaveBeenCalled()
    fireEvent.click(close)
    act(() => vi.advanceTimersByTime(250))
    expect(onDismiss).toHaveBeenCalledWith(1)
  })

  it('Fehler-Hinweis ohne Maus und Fokus verschwindet nach seiner Dauer', () => {
    const { onDismiss } = renderToast()
    act(() => vi.advanceTimersByTime(3300))
    expect(onDismiss).toHaveBeenCalledWith(1)
  })
})
