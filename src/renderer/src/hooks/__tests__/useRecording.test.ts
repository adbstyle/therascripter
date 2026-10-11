import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useRecording } from '../useRecording'
import type { LevelCallback } from '../../services/AudioRecorder'

// AudioRecorder mocken: getUserMedia/AudioWorklet gibt es in jsdom nicht.
// Der Test steuert die Worklet-Pegel über das gemerkte onLevel.
let emitLevel: LevelCallback = () => {}
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
  window.api = {
    recording: {
      onDuration: vi.fn().mockReturnValue(() => {}),
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

describe('useRecording – Pegel', () => {
  it('reicht Worklet-Pegel an Abonnenten weiter, bis sie sich abmelden', async () => {
    const { result } = await renderRecording()
    const listener = vi.fn()
    const unsubscribe = result.current.subscribeLevel(listener)

    emitLevel(0.25)
    emitLevel(0.5)
    expect(listener).toHaveBeenNthCalledWith(1, 0.25)
    expect(listener).toHaveBeenNthCalledWith(2, 0.5)

    unsubscribe()
    emitLevel(0.75)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  // Issue #140: Der Pegel lag im React-State und liess die ganze App mit
  // jedem Frame neu rendern.
  it('löst pro Pegelwert keinen Render aus', async () => {
    const { result, renders } = await renderRecording()
    result.current.subscribeLevel(() => {})
    const before = renders()

    act(() => {
      for (let i = 0; i < 100; i++) emitLevel(Math.random())
    })

    expect(renders()).toBe(before)
  })

  it('liefert eine stabile subscribeLevel-Referenz', async () => {
    const { result } = await renderRecording()
    const first = result.current.subscribeLevel

    await act(() => result.current.stopRecording())
    expect(result.current.isRecording).toBe(false)
    expect(result.current.subscribeLevel).toBe(first)
  })
})
