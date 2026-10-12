import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useMicrophonePermission } from '../useMicrophonePermission'
import type { MicrophoneState } from '../../../../shared/types/Microphone'

let state: MicrophoneState
const mic = {
  getState: vi.fn(async () => state),
  ensureAccess: vi.fn(async () => 'granted'),
  dismissHint: vi.fn(async () => {}),
  openSettings: vi.fn(async () => {})
}

beforeEach(() => {
  vi.clearAllMocks()
  state = { status: 'granted', previouslyGranted: true }
  window.api = { microphone: mic } as unknown as typeof window.api
})

function setVisibility(value: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { value, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('useMicrophonePermission', () => {
  it('zeigt keinen Hinweis bei erteilter Berechtigung', async () => {
    const { result } = renderHook(() => useMicrophonePermission())
    await waitFor(() => expect(mic.getState).toHaveBeenCalled())
    expect(result.current.hint).toBeNull()
  })

  it('weist beim Start auf eine verlorene Berechtigung hin', async () => {
    state = { status: 'not-determined', previouslyGranted: true }
    const { result } = renderHook(() => useMicrophonePermission())
    await waitFor(() => expect(result.current.hint).toBe('lost'))
  })

  it.each<MicrophoneState>([
    { status: 'not-determined', previouslyGranted: false },
    { status: 'denied', previouslyGranted: true }
  ])('weist beim Start nicht hin bei %o (erst beim Aufnahmestart)', async (s) => {
    state = s
    const { result } = renderHook(() => useMicrophonePermission())
    await waitFor(() => expect(mic.getState).toHaveBeenCalled())
    expect(result.current.hint).toBeNull()
  })

  it('prüft beim Sichtbarwerden des Fensters erneut', async () => {
    const { result } = renderHook(() => useMicrophonePermission())
    await waitFor(() => expect(mic.getState).toHaveBeenCalledTimes(1))

    state = { status: 'not-determined', previouslyGranted: true }
    act(() => setVisibility('visible'))

    await waitFor(() => expect(result.current.hint).toBe('lost'))
  })

  it('prüft beim Fokus des Fensters erneut (Rückkehr aus den Systemeinstellungen)', async () => {
    state = { status: 'denied', previouslyGranted: false }
    const { result } = renderHook(() => useMicrophonePermission())
    await waitFor(() => expect(mic.getState).toHaveBeenCalledTimes(1))
    act(() => result.current.showDenied())

    state = { status: 'granted', previouslyGranted: true }
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })

    await waitFor(() => expect(result.current.hint).toBeNull())
  })

  it('«Mikrofon erlauben» fragt macOS und blendet den Hinweis aus, auch nach Ablehnung', async () => {
    state = { status: 'not-determined', previouslyGranted: true }
    mic.ensureAccess.mockResolvedValueOnce('denied')
    const { result } = renderHook(() => useMicrophonePermission())
    await waitFor(() => expect(result.current.hint).toBe('lost'))

    await act(() => result.current.allow())

    expect(mic.ensureAccess).toHaveBeenCalledOnce()
    expect(result.current.hint).toBeNull()
  })

  it('«Später» merkt sich die Entscheidung im Main-Prozess', async () => {
    state = { status: 'not-determined', previouslyGranted: true }
    const { result } = renderHook(() => useMicrophonePermission())
    await waitFor(() => expect(result.current.hint).toBe('lost'))

    act(() => result.current.dismiss())

    expect(mic.dismissHint).toHaveBeenCalledOnce()
    expect(result.current.hint).toBeNull()
  })

  it('hält den Aufnahme-Hinweis beim Zurückkehren, bis die Berechtigung erteilt ist', async () => {
    state = { status: 'denied', previouslyGranted: false }
    const { result } = renderHook(() => useMicrophonePermission())
    await waitFor(() => expect(mic.getState).toHaveBeenCalledTimes(1))

    act(() => result.current.showDenied())
    act(() => setVisibility('visible'))
    await waitFor(() => expect(mic.getState).toHaveBeenCalledTimes(2))
    expect(result.current.hint).toBe('denied')

    state = { status: 'granted', previouslyGranted: true }
    act(() => setVisibility('visible'))
    await waitFor(() => expect(result.current.hint).toBeNull())
  })

  it('Wegklicken des Aufnahme-Hinweises ändert nichts im Main-Prozess', () => {
    const { result } = renderHook(() => useMicrophonePermission())
    act(() => result.current.showDenied())
    act(() => result.current.dismiss())
    expect(mic.dismissHint).not.toHaveBeenCalled()
    expect(result.current.hint).toBeNull()
  })
})
