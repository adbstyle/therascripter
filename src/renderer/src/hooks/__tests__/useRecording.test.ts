import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useRecording } from '../useRecording'
import type { LevelCallback } from '../../services/AudioRecorder'

// AudioRecorder mocken: getUserMedia/AudioWorklet gibt es in jsdom nicht.
// Der Test steuert die Worklet-Pegel über das gemerkte onLevel.
let emitLevel: LevelCallback = () => {}
let emitDuration: (data: { seconds: number }) => void = () => {}
let recorderStart: (onLevel: LevelCallback) => Promise<string> = async (onLevel) => {
  emitLevel = onLevel
  return 'session-1'
}
vi.mock('../../services/AudioRecorder', () => ({
  AudioRecorder: class {
    start(onLevel: LevelCallback): Promise<string> {
      return recorderStart(onLevel)
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
    return 'session-1'
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
  it('klärt die Berechtigung vor dem Start', async () => {
    const { result } = renderHook(() => useRecording())
    await act(() => result.current.startRecording())
    expect(ensureAccess).toHaveBeenCalledOnce()
    expect(result.current.isRecording).toBe(true)
  })

  it.each(['denied', 'restricted'])(
    'startet bei Status %s nicht und meldet die Ablehnung statt eines Toasts',
    async (status) => {
      ensureAccess.mockResolvedValue(status)
      const start = vi.fn()
      recorderStart = start
      const onMicrophoneDenied = vi.fn()
      const { result } = renderHook(() => useRecording({ onMicrophoneDenied }))

      await act(() => result.current.startRecording())

      expect(start).not.toHaveBeenCalled()
      expect(onMicrophoneDenied).toHaveBeenCalledOnce()
      expect(result.current.isRecording).toBe(false)
      expect(result.current.error).toBeNull()
    }
  )

  it('meldet NotAllowedError von getUserMedia ebenfalls als Ablehnung', async () => {
    recorderStart = () => Promise.reject(new DOMException('denied', 'NotAllowedError'))
    const onMicrophoneDenied = vi.fn()
    const { result } = renderHook(() => useRecording({ onMicrophoneDenied }))

    await act(() => result.current.startRecording())

    expect(onMicrophoneDenied).toHaveBeenCalledOnce()
    expect(result.current.error).toBeNull()
  })
})
