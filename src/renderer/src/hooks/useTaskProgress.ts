import { useCallback, useEffect, useRef, useState } from 'react'
import type { Task, TaskType } from '../../../shared/types'

const TRANSITION_TIMEOUT_MS = 500

/**
 * Issue #80 / Phase E — Hook surface for SessionCard's processing UI.
 *
 * Architecture decisions baked in here:
 * - DR-2: backend (task:started) is SOT for "current step" — we never predict
 *   the next step from the local AUDIO_PIPELINE constant. Between a completed
 *   task and the next task:started, the bar freezes at 100% for 500 ms; if
 *   the next started doesn't arrive in time, we surface an explicit
 *   "preparing next step" transition state.
 * - DR-3: separate listeners for progress / started / completed / error /
 *   queuePositions — single hook subscribes to all five.
 */

export interface CurrentStepState {
  taskType: TaskType
  /** 0..1 */
  progress: number
  /** 1-based index from task:started, or 0 if unknown */
  stepIndex: number
  /** From task:started, or 0 if unknown */
  totalSteps: number
  /** Total session ETA in seconds, or null until estimator is calibrated */
  etaSecondsTotal: number | null
  /** Estimated duration of the current step in seconds, or null */
  plannedDurationSec: number | null
  /** True after task:completed if no task:started arrives within 500 ms */
  isTransitioning: boolean
}

interface UseTaskProgressResult {
  tasks: Task[]
  loading: boolean
  current: CurrentStepState | null
  /** 1-based queue position from queue:positions, or null if not queued */
  queuePosition: number | null
}

export function useTaskProgress(
  sessionId: string | null,
  plannedSteps: TaskType[] | null = null
): UseTaskProgressResult {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [current, setCurrent] = useState<CurrentStepState | null>(null)
  const [queuePosition, setQueuePosition] = useState<number | null>(null)
  const transitionTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(async () => {
    if (!sessionId) {
      setTasks([])
      setLoading(false)
      return
    }
    try {
      const result = await window.api.tasks.getSessionTasks(sessionId)
      setTasks(result)
    } catch {
      // Best effort — tasks may not exist yet
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  // Initial fetch
  useEffect(() => {
    refresh()
  }, [refresh])

  // Issue #80 mid-pipeline mount fix: when the SessionCard mounts while the
  // pipeline is already running (e.g. after a recording-stop where step 1's
  // task:started was emitted before the renderer subscribed, or after a
  // dashboard re-mount mid-pipeline), the hook would stay stuck on `current=null`
  // and the card would render the "Verarbeitung" status fallback until the
  // next step boundary's task:started arrives.
  //
  // Recover by synthesising `current` from the running task in tasks[] +
  // session.plannedSteps. progress is live in the Task row (executors update
  // on every heartbeat). etaSecondsTotal/plannedDurationSec stay null until
  // the next task:progress tick fills them — that's the same null they would
  // have under uncalibrated estimator anyway.
  //
  // Guard: only synthesise when current is null. Once a real task:started or
  // task:progress event lands, those handlers own `current` and the synthesis
  // becomes a no-op.
  useEffect(() => {
    if (current !== null) return
    if (!plannedSteps || plannedSteps.length === 0) return
    const running = tasks.find((t) => t.status === 'running')
    if (!running) return
    const stepIndex = plannedSteps.indexOf(running.type) + 1
    if (stepIndex === 0) return
    setCurrent({
      taskType: running.type,
      progress: running.progress ?? 0,
      stepIndex,
      totalSteps: plannedSteps.length,
      etaSecondsTotal: null,
      plannedDurationSec: null,
      isTransitioning: false
    })
  }, [tasks, plannedSteps, current])

  // task:started — replaces any pending transition timer and overwrites current
  useEffect(() => {
    if (!sessionId) return
    return window.api.tasks.onStarted((data) => {
      if (data.sessionId !== sessionId) return
      if (transitionTimer.current) {
        clearTimeout(transitionTimer.current)
        transitionTimer.current = null
      }
      setCurrent({
        taskType: data.taskType,
        progress: 0,
        stepIndex: data.stepIndex,
        totalSteps: data.totalSteps,
        etaSecondsTotal: null,
        plannedDurationSec: data.plannedDurationSec,
        isTransitioning: false
      })
    })
  }, [sessionId])

  // task:progress — updates progress + ETA on the active task
  useEffect(() => {
    if (!sessionId) return
    return window.api.tasks.onProgress((data) => {
      if (data.sessionId !== sessionId) return
      setCurrent((prev) =>
        prev && prev.taskType === data.taskType
          ? {
              ...prev,
              progress: data.progress,
              etaSecondsTotal: data.etaSecondsTotal,
              isTransitioning: false
            }
          : prev
      )
    })
  }, [sessionId])

  // task:completed — freeze at 100 % and arm the transition timer
  useEffect(() => {
    if (!sessionId) return
    return window.api.tasks.onCompleted((data) => {
      if (data.sessionId !== sessionId) return
      setCurrent((prev) =>
        prev && prev.taskType === data.taskType ? { ...prev, progress: 1 } : prev
      )
      if (transitionTimer.current) clearTimeout(transitionTimer.current)
      transitionTimer.current = setTimeout(() => {
        transitionTimer.current = null
        setCurrent((prev) => (prev ? { ...prev, isTransitioning: true } : null))
      }, TRANSITION_TIMEOUT_MS)
      refresh()
    })
  }, [sessionId, refresh])

  // task:error — clear state, refresh tasks
  useEffect(() => {
    if (!sessionId) return
    return window.api.tasks.onError((data) => {
      if (data.sessionId !== sessionId) return
      if (transitionTimer.current) {
        clearTimeout(transitionTimer.current)
        transitionTimer.current = null
      }
      setCurrent(null)
      refresh()
    })
  }, [sessionId, refresh])

  // queue:positions — track position for waiting cards
  useEffect(() => {
    if (!sessionId) return
    return window.api.tasks.onQueuePositions((data) => {
      setQueuePosition(data.positions[sessionId] ?? null)
    })
  }, [sessionId])

  // Cleanup on unmount
  useEffect(
    () => () => {
      if (transitionTimer.current) clearTimeout(transitionTimer.current)
    },
    []
  )

  return { tasks, loading, current, queuePosition }
}
