import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useRecording } from '../useRecording'
import type { LevelCallback } from '../../services/AudioRecorder'
import type { RecordingStartOptions, RecordingStartResult } from '../../../../shared/types/IpcApi'

// AudioRecorder mocken: getUserMedia/AudioWorklet gibt es in jsdom nicht.
// Der Test steuert die Worklet-Pegel über das gemerkte onLevel.
const META = { title: 'Aufnahme 14.11.2026 10:05', createdAt: '2026-11-14T09:05:00.000Z' }
let emitLevel: LevelCallback = () => {}
let emitDuration: (data: { seconds: number }) => void = () => {}
let recorderStart: (
  onLevel: LevelCallback,
  options?: RecordingStartOptions
) => Promise<RecordingStartResult> = async (onLevel) => {
  emitLevel = onLevel
  return { sessionId: 'session-1', assignment: 'none', ...META }
}
vi.mock('../../services/AudioRecorder', () => ({
  AudioRecorder: class {
    start(onLevel: LevelCallback, options?: RecordingStartOptions): Promise<RecordingStartResult> {
      return recorderStart(onLevel, options)
    }
    async stop(): Promise<void> {}
  }
}))

let ensureAccess: ReturnType<typeof vi.fn>

beforeEach(() => {
  emitLevel = () => {}
  emitDuration = () => {}
  recorderStart = async (onLevel) => {
    emitLevel = onLevel
    return { sessionId: 'session-1', assignment: 'none', ...META }
  }
  ensureAccess = vi.fn().mockResolvedValue('granted')
  window.api = {
    microphone: { ensureAccess },
    recording: {
      onDuration: vi.fn((cb) => {
        emitDuration = cb
        return () => {}
      }),
      onError: vi.fn().mockReturnValue(() => {}),
      onAutoStopped: vi.fn().mockReturnValue(() => {})
    }
  } as unknown as typeof window.api
})

async function renderRecording(): Promise<{
  result: { current: ReturnType<typeof useRecording> }
  renders: () => number
}> {
  let renderCount = 0
  const { result } = renderHook(() => {
    renderCount++
    return useRecording()
  })
  await act(() => result.current.startRecording())
  expect(result.current.isRecording).toBe(true)
  return { result, renders: () => renderCount }
}

describe('useRecording – Pegel und Dauer', () => {
  it('reicht Worklet-Pegel an Abonnenten weiter, bis sie sich abmelden', async () => {
    const { result } = await renderRecording()
    const listener = vi.fn()
    const unsubscribe = result.current.level.subscribe(listener)

    emitLevel(0.25)
    emitLevel(0.5)
    expect(listener).toHaveBeenNthCalledWith(1, 0.25)
    expect(listener).toHaveBeenNthCalledWith(2, 0.5)

    unsubscribe()
    emitLevel(0.75)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  // Issue #140: Pegel und Dauer lagen im React-State von App und liessen die
  // ganze App mit jedem Wert neu rendern.
  it('löst pro Pegel- und Dauerwert keinen Render aus', async () => {
    const { result, renders } = await renderRecording()
    result.current.level.subscribe(() => {})
    const before = renders()

    act(() => {
      for (let i = 0; i < 100; i++) emitLevel(Math.random())
      emitDuration({ seconds: 42 })
    })

    expect(renders()).toBe(before)
    expect(result.current.duration.get()).toBe(42)
  })

  it('setzt die Dauer beim Stopp zurück und behält die Stores', async () => {
    const { result } = await renderRecording()
    const { level, duration } = result.current
    act(() => emitDuration({ seconds: 42 }))

    await act(() => result.current.stopRecording())
    expect(result.current.isRecording).toBe(false)
    expect(duration.get()).toBe(0)
    expect(result.current.level).toBe(level)
    expect(result.current.duration).toBe(duration)
  })

  it('setzt den Pegel beim Stopp auf null', async () => {
    const { result } = await renderRecording()
    emitLevel(0.5)

    await act(() => result.current.stopRecording())
    expect(result.current.level.get()).toBe(0)
  })

  // Ein Dauer-Event kann nach dem Reset beim Stopp noch eintreffen —
  // die nächste Aufnahme muss trotzdem bei 0 beginnen.
  it('startet die Dauer bei jeder Aufnahme bei null', async () => {
    const { result } = await renderRecording()
    await act(() => result.current.stopRecording())
    act(() => emitDuration({ seconds: 2820 }))
    expect(result.current.duration.get()).toBe(2820)

    await act(() => result.current.startRecording())
    expect(result.current.duration.get()).toBe(0)
  })
})

describe('useRecording – Mikrofon-Berechtigung (Issue #161)', () => {
  it('klärt die Berechtigung vor dem Start und meldet den Status', async () => {
    const onMicrophoneStatus = vi.fn()
    const { result } = renderHook(() => useRecording({ onMicrophoneStatus }))
    await act(() => result.current.startRecording())
    expect(ensureAccess).toHaveBeenCalledOnce()
    expect(onMicrophoneStatus).toHaveBeenCalledWith('granted')
    expect(result.current.isRecording).toBe(true)
  })

  it('meldet eine erteilte Berechtigung auch, wenn die Aufnahme danach scheitert', async () => {
    recorderStart = () => Promise.reject(new DOMException('none', 'NotFoundError'))
    const onMicrophoneStatus = vi.fn()
    const { result } = renderHook(() => useRecording({ onMicrophoneStatus }))

    await act(() => result.current.startRecording())

    expect(onMicrophoneStatus).toHaveBeenCalledWith('granted')
    expect(result.current.error).toMatch(/Kein Mikrofon gefunden/)
  })

  it.each(['denied', 'restricted'])(
    'startet bei Status %s nicht und meldet die Ablehnung statt eines Toasts',
    async (status) => {
      ensureAccess.mockResolvedValue(status)
      const start = vi.fn()
      recorderStart = start
      const onMicrophoneStatus = vi.fn()
      const { result } = renderHook(() => useRecording({ onMicrophoneStatus }))

      await act(() => result.current.startRecording())

      expect(start).not.toHaveBeenCalled()
      expect(onMicrophoneStatus).toHaveBeenCalledWith(status)
      expect(result.current.isRecording).toBe(false)
      expect(result.current.error).toBeNull()
    }
  )

  it('meldet NotAllowedError von getUserMedia ebenfalls als Ablehnung', async () => {
    recorderStart = () => Promise.reject(new DOMException('denied', 'NotAllowedError'))
    const onMicrophoneStatus = vi.fn()
    const { result } = renderHook(() => useRecording({ onMicrophoneStatus }))

    await act(() => result.current.startRecording())

    expect(onMicrophoneStatus).toHaveBeenLastCalledWith('denied')
    expect(result.current.error).toBeNull()
  })
})

describe('useRecording – Start aus einem Patientendossier (#206)', () => {
  it('reicht das Dossier durch und merkt es sich bei gelungener Zuordnung', async () => {
    const start = vi.fn(async () => ({
      sessionId: 's-7',
      assignment: 'assigned' as const,
      ...META
    }))
    recorderStart = start
    const { result } = renderHook(() => useRecording())

    let returned: RecordingStartResult | null = null
    await act(async () => {
      returned = await result.current.startRecording({ dossierId: 'd1' })
    })

    expect(start).toHaveBeenCalledWith(expect.any(Function), { dossierId: 'd1' })
    expect(returned).toMatchObject({ sessionId: 's-7', assignment: 'assigned' })
    expect(result.current.sessionId).toBe('s-7')
    expect(result.current.dossierId).toBe('d1')

    await act(() => result.current.stopRecording())
    expect(result.current.dossierId).toBeNull()
  })

  it('läuft bei gescheiterter Zuordnung trotzdem, ohne Dossier', async () => {
    recorderStart = async () => ({ sessionId: 's-8', assignment: 'failed', ...META })
    const { result } = renderHook(() => useRecording())
    await act(() => result.current.startRecording({ dossierId: 'd1' }).then(() => undefined))
    expect(result.current.isRecording).toBe(true)
    expect(result.current.dossierId).toBeNull()
  })

  it('startet ohne Dossier ohne Optionen und lehnt eine zweite Aufnahme ab', async () => {
    const start = vi.fn(async () => ({ sessionId: 's-9', assignment: 'none' as const, ...META }))
    recorderStart = start
    const { result } = renderHook(() => useRecording())
    await act(() => result.current.startRecording().then(() => undefined))
    expect(start).toHaveBeenCalledWith(expect.any(Function), undefined)

    let second: RecordingStartResult | null = { sessionId: 'x', assignment: 'none', ...META }
    await act(async () => {
      second = await result.current.startRecording({ dossierId: 'd1' })
    })
    expect(second).toBeNull()
    expect(start).toHaveBeenCalledTimes(1)
  })
})
