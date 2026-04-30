import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useTaskProgress } from '../useTaskProgress'
import type {
  TaskProgressData,
  TaskStartedData,
  TaskCompletedData,
  TaskErrorData,
  QueuePositionsData
} from '../../../../shared/types'

interface ListenerMap {
  progress: ((d: TaskProgressData) => void)[]
  started: ((d: TaskStartedData) => void)[]
  completed: ((d: TaskCompletedData) => void)[]
  error: ((d: TaskErrorData) => void)[]
  queuePositions: ((d: QueuePositionsData) => void)[]
}

function createMockApi(): {
  api: typeof window.api
  emit: {
    started: (d: TaskStartedData) => void
    progress: (d: TaskProgressData) => void
    completed: (d: TaskCompletedData) => void
    error: (d: TaskErrorData) => void
    queuePositions: (d: QueuePositionsData) => void
  }
} {
  const handlers: ListenerMap = {
    progress: [],
    started: [],
    completed: [],
    error: [],
    queuePositions: []
  }
  const sub = <K extends keyof ListenerMap>(key: K) => {
    return (cb: ListenerMap[K][number]): (() => void) => {
      handlers[key].push(cb as never)
      return () => {
        handlers[key] = handlers[key].filter((h) => h !== cb) as never
      }
    }
  }
  const api = {
    tasks: {
      getSessionTasks: vi.fn().mockResolvedValue([]),
      isProcessing: vi.fn().mockResolvedValue(false),
      retry: vi.fn().mockResolvedValue(undefined),
      onProgress: sub('progress'),
      onStarted: sub('started'),
      onCompleted: sub('completed'),
      onError: sub('error'),
      onQueuePositions: sub('queuePositions')
    }
  } as unknown as typeof window.api
  return {
    api,
    emit: {
      started: (d) => handlers.started.forEach((h) => h(d)),
      progress: (d) => handlers.progress.forEach((h) => h(d)),
      completed: (d) => handlers.completed.forEach((h) => h(d)),
      error: (d) => handlers.error.forEach((h) => h(d)),
      queuePositions: (d) => handlers.queuePositions.forEach((h) => h(d))
    }
  }
}

describe('useTaskProgress', () => {
  let mock: ReturnType<typeof createMockApi>

  beforeEach(() => {
    mock = createMockApi()
    ;(window as unknown as { api: typeof window.api }).api = mock.api
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('initialises with null current and queuePosition', async () => {
    const { result } = renderHook(() => useTaskProgress('s1'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.current).toBeNull()
    expect(result.current.queuePosition).toBeNull()
  })

  it('starts a step on task:started', async () => {
    const { result } = renderHook(() => useTaskProgress('s1'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() =>
      mock.emit.started({
        sessionId: 's1',
        taskType: 'transcription',
        stepIndex: 3,
        totalSteps: 5,
        plannedDurationSec: 120
      })
    )
    expect(result.current.current).toMatchObject({
      taskType: 'transcription',
      progress: 0,
      stepIndex: 3,
      totalSteps: 5,
      plannedDurationSec: 120,
      isTransitioning: false
    })
  })

  it('updates progress on task:progress', async () => {
    const { result } = renderHook(() => useTaskProgress('s1'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => {
      mock.emit.started({
        sessionId: 's1',
        taskType: 'transcription',
        stepIndex: 3,
        totalSteps: 5,
        plannedDurationSec: 120
      })
      mock.emit.progress({
        sessionId: 's1',
        taskType: 'transcription',
        progress: 0.42,
        etaSecondsTotal: 90
      })
    })
    expect(result.current.current?.progress).toBe(0.42)
    expect(result.current.current?.etaSecondsTotal).toBe(90)
  })

  it('ignores progress events for non-active task types', async () => {
    const { result } = renderHook(() => useTaskProgress('s1'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => {
      mock.emit.started({
        sessionId: 's1',
        taskType: 'transcription',
        stepIndex: 3,
        totalSteps: 5,
        plannedDurationSec: 120
      })
      mock.emit.progress({
        sessionId: 's1',
        taskType: 'diarization', // wrong task — must not overwrite
        progress: 0.99,
        etaSecondsTotal: 5
      })
    })
    expect(result.current.current?.taskType).toBe('transcription')
    expect(result.current.current?.progress).toBe(0)
  })

  it('freezes at 100% on task:completed and does not clear immediately', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { result } = renderHook(() => useTaskProgress('s1'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => {
      mock.emit.started({
        sessionId: 's1',
        taskType: 'transcription',
        stepIndex: 3,
        totalSteps: 5,
        plannedDurationSec: 120
      })
      mock.emit.completed({ sessionId: 's1', taskType: 'transcription' })
    })
    expect(result.current.current?.progress).toBe(1)
    expect(result.current.current?.isTransitioning).toBe(false)
  })

  it('flips to isTransitioning after 500 ms with no task:started', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { result } = renderHook(() => useTaskProgress('s1'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => {
      mock.emit.started({
        sessionId: 's1',
        taskType: 'transcription',
        stepIndex: 3,
        totalSteps: 5,
        plannedDurationSec: 120
      })
      mock.emit.completed({ sessionId: 's1', taskType: 'transcription' })
    })
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(result.current.current?.isTransitioning).toBe(true)
  })

  it('clears the transition timer when task:started arrives within 500 ms', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { result } = renderHook(() => useTaskProgress('s1'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => {
      mock.emit.started({
        sessionId: 's1',
        taskType: 'transcription',
        stepIndex: 3,
        totalSteps: 5,
        plannedDurationSec: 120
      })
      mock.emit.completed({ sessionId: 's1', taskType: 'transcription' })
      mock.emit.started({
        sessionId: 's1',
        taskType: 'anonymization',
        stepIndex: 4,
        totalSteps: 5,
        plannedDurationSec: 30
      })
    })
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(result.current.current?.taskType).toBe('anonymization')
    expect(result.current.current?.isTransitioning).toBe(false)
  })

  it('clears current on task:error', async () => {
    const { result } = renderHook(() => useTaskProgress('s1'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => {
      mock.emit.started({
        sessionId: 's1',
        taskType: 'transcription',
        stepIndex: 3,
        totalSteps: 5,
        plannedDurationSec: 120
      })
      mock.emit.error({ sessionId: 's1', taskType: 'transcription', error: 'boom' })
    })
    expect(result.current.current).toBeNull()
  })

  it('tracks queue position from queue:positions', async () => {
    const { result } = renderHook(() => useTaskProgress('s1'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => mock.emit.queuePositions({ positions: { s1: 2, s2: 1 } }))
    expect(result.current.queuePosition).toBe(2)
  })

  it('returns null queuePosition when sessionId is absent from broadcast', async () => {
    const { result } = renderHook(() => useTaskProgress('s1'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => mock.emit.queuePositions({ positions: { s2: 1 } }))
    expect(result.current.queuePosition).toBeNull()
  })

  it('ignores events for other sessions', async () => {
    const { result } = renderHook(() => useTaskProgress('s1'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() =>
      mock.emit.started({
        sessionId: 'other',
        taskType: 'transcription',
        stepIndex: 1,
        totalSteps: 5,
        plannedDurationSec: 120
      })
    )
    expect(result.current.current).toBeNull()
  })
})
