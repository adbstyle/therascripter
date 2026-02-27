import { useCallback, useEffect, useState } from 'react'
import type { Task, TaskType } from '../../../shared/types'

interface TaskProgressState {
  taskType: TaskType
  progress: number
}

interface UseTaskProgressResult {
  tasks: Task[]
  loading: boolean
  currentProgress: TaskProgressState | null
}

export function useTaskProgress(sessionId: string | null): UseTaskProgressResult {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [currentProgress, setCurrentProgress] = useState<TaskProgressState | null>(null)

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

  // Listen for progress updates
  useEffect(() => {
    if (!sessionId) return

    const cleanup = window.api.tasks.onProgress((data) => {
      if (data.sessionId !== sessionId) return
      setCurrentProgress({ taskType: data.taskType, progress: data.progress })
    })

    return cleanup
  }, [sessionId])

  // Listen for task completion — refresh task list and clear progress
  useEffect(() => {
    if (!sessionId) return

    const cleanup = window.api.tasks.onCompleted((data) => {
      if (data.sessionId !== sessionId) return
      setCurrentProgress(null)
      refresh()
    })

    return cleanup
  }, [sessionId, refresh])

  // Listen for task errors — refresh task list and clear progress
  useEffect(() => {
    if (!sessionId) return

    const cleanup = window.api.tasks.onError((data) => {
      if (data.sessionId !== sessionId) return
      setCurrentProgress(null)
      refresh()
    })

    return cleanup
  }, [sessionId, refresh])

  return { tasks, loading, currentProgress }
}
