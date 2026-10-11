import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useRecording } from '../useRecording'
import type { LevelCallback } from '../../services/AudioRecorder'

// AudioRecorder mocken: getUserMedia/AudioWorklet gibt es in jsdom nicht.
// Der Test steuert die Worklet-Pegel über das gemerkte onLevel.
let emitLevel: LevelCallback = () => {}
let emitDuration: (data: { seconds: number }) => void = () => {}
vi.mock('../../services/AudioRecorder', () => ({
  AudioRecorder: class {
    async start(onLevel: LevelCallback): Promise<string> {
      emitLevel = onLevel
      return 'session-1'
    }
    async stop(): Promise<void> {}
  }
}))

beforeEach(() => {
  emitLevel = () => {}
  emitDuration = () => {}
  window.api = {
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
})
