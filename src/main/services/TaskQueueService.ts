import { statSync } from 'fs'
import type Database from 'better-sqlite3'
import { TaskRepository } from '../db/repositories/TaskRepository'
import { SessionService } from './SessionService'
import { ProcessWatchdog } from './ProcessWatchdog'
import type { TaskExecutor } from './task-executors'
import { createStubExecutors } from './task-executors'
import { sendToRenderer } from '../utils/ipc-helpers'
import { validateIntermediateFile } from '../utils/file-ops'
import type { Task, TaskType, Session, SessionStatus, SessionType } from '../../shared/types'
import { AUDIO_PIPELINE, PDF_PIPELINE } from '../../shared/constants/pipeline'

// Issue #80 / DR-5: tasks[] is the source of truth for "current step".
// SessionStatus only carries lifecycle phase (queued / processing / review / error / recording).
// The previous TASK_TO_SESSION_STATUS map and getSessionStatusForTask helper were removed.

const RECOVERY_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

export class TaskQueueService {
  private repository: TaskRepository
  private sessionService: SessionService
  private executors: Map<TaskType, TaskExecutor>
  private processing = false
  private shouldStop = false
  private recoveryTimer: ReturnType<typeof setInterval> | null = null

  constructor(db: Database.Database) {
    this.repository = new TaskRepository(db)
    this.sessionService = new SessionService(db)
    this.executors = createStubExecutors()
  }

  registerExecutor(type: TaskType, executor: TaskExecutor): void {
    this.executors.set(type, executor)
  }

  enqueuePipeline(sessionId: string, sessionType: SessionType): Task[] {
    const pipeline = sessionType === 'audio' ? AUDIO_PIPELINE : PDF_PIPELINE
    const tasks: Task[] = []

    for (const type of pipeline) {
      tasks.push(this.repository.create({ sessionId, type }))
    }

    console.log(`[TaskQueue] Enqueued ${pipeline.length} tasks for session ${sessionId} (${sessionType})`)

    // Kick off processing if not already running
    this.scheduleNext()

    return tasks
  }

  getSessionTasks(sessionId: string): Task[] {
    return this.repository.findBySession(sessionId)
  }

  retrySession(sessionId: string): void {
    const session = this.sessionService.getSession(sessionId)
    if (!session) throw new Error(`Session ${sessionId} nicht gefunden`)
    if (session.status !== 'error') {
      throw new Error(`Session ${sessionId} ist nicht im Fehlerstatus`)
    }

    const pipeline = session.type === 'audio' ? AUDIO_PIPELINE : PDF_PIPELINE
    const resumeIndex = this.findResumeIndex(session, pipeline)

    // Remove all non-completed task rows (failed + cancelled)
    const deleted = this.repository.deleteNonCompletedForSession(sessionId)
    if (deleted > 0) {
      console.log(`[TaskQueue] Deleted ${deleted} non-completed tasks for session ${sessionId}`)
    }

    // Create pending tasks for remaining pipeline steps
    const remainingSteps = pipeline.slice(resumeIndex)
    for (const type of remainingSteps) {
      this.repository.create({ sessionId, type })
    }

    // Transition session: error → queued. The first task's start will then push
    // queued → processing automatically (see executeTask). errorMessage is cleared
    // so the renderer doesn't surface stale state from the failed run while the
    // retry is in flight.
    this.sessionService.updateSession(sessionId, {
      status: 'queued',
      errorMessage: null
    })

    console.log(
      `[TaskQueue] Retrying session ${sessionId} from step ${remainingSteps[0]} ` +
        `(skipping ${resumeIndex} completed step(s))`
    )

    this.scheduleNext()
  }

  private findResumeIndex(session: Session, pipeline: readonly TaskType[]): number {
    // Maps each task type to the session field that proves it completed successfully
    const outputField: Partial<Record<TaskType, string | null>> = {
      transcription: session.transcriptPath,
      diarization: session.diarizationPath,
      alignment: session.alignedTranscriptPath,
      extraction: session.extractedPath,
      anonymization: session.anonymizedPath
    }

    for (let i = 0; i < pipeline.length; i++) {
      const taskType = pipeline[i]

      // OCR has no separate output file — always re-run if reached
      if (taskType === 'ocr') return i

      // Summarization writes to sessions.summary directly (no separate file).
      // It's also the last step in both pipelines, so once everything before
      // succeeded the only remaining work is to (re-)run summarization.
      if (taskType === 'summarization') return i

      const filePath = outputField[taskType]
      if (!filePath) return i

      const result = validateIntermediateFile(filePath)
      if (!result.ok) {
        console.warn(`[TaskQueue] Resume validation failed for ${taskType}: ${result.error}`)
        return i
      }
    }

    // All steps reported valid output — restart from the last step (summarization).
    // In practice the explicit summarization branch above will have already
    // returned; this is the defensive fallback if the pipeline ever changes shape.
    return pipeline.length - 1
  }

  recoverStuckTasks(): number {
    return this.repository.resetRunningToPending()
  }

  /** Find sessions stuck in a processing state with no pending/running tasks and mark as error */
  recoverOrphanedSessions(): number {
    const processingStatuses: SessionStatus[] = ['queued', 'processing']
    let recovered = 0

    const allSessions = this.sessionService.getAllSessions()

    for (const session of allSessions) {
      if (!processingStatuses.includes(session.status)) continue

      const tasks = this.repository.findBySession(session.id)
      const hasPendingOrRunning = tasks.some(
        (t) => t.status === 'pending' || t.status === 'running'
      )

      if (!hasPendingOrRunning) {
        try {
          this.sessionService.updateSession(session.id, {
            status: 'error',
            errorMessage: 'Verarbeitung wurde unerwartet abgebrochen.'
          })
          console.log(`[TaskQueue] Recovered orphaned session ${session.id} (was ${session.status})`)
          recovered++
        } catch (err) {
          console.error(`[TaskQueue] Failed to recover orphaned session ${session.id}:`, err)
        }
      }
    }

    return recovered
  }

  start(): void {
    this.shouldStop = false
    this.startPeriodicRecovery()
    this.scheduleNext()
  }

  stop(): void {
    this.shouldStop = true
    this.stopPeriodicRecovery()
  }

  isProcessing(): boolean {
    return this.processing
  }

  /** Fire-and-forget wrapper that swallows rejections during shutdown */
  private scheduleNext(): void {
    this.processNext().catch(() => {
      // Swallow errors during shutdown (e.g., DB closed)
    })
  }

  private async processNext(): Promise<void> {
    if (this.processing || this.shouldStop) return

    let task: Task | null
    try {
      task = this.repository.findPending()
    } catch {
      // DB may be closed during shutdown
      return
    }
    if (!task) return

    this.processing = true
    console.log(`[TaskQueue] Starting task ${task.type} for session ${task.sessionId}`)

    const executor = this.executors.get(task.type)
    if (!executor) {
      const error = `No executor registered for task type: ${task.type}`
      console.error(`[TaskQueue] ${error}`)
      this.repository.update(task.id, {
        status: 'failed',
        error,
        completedAt: new Date().toISOString()
      })
      this.handleTaskFailure(task, error)
      this.processing = false
      this.scheduleNext()
      return
    }

    // Issue #80 DR-5: transition session queued → processing on first task start.
    // While further tasks remain, the status stays 'processing' (self-transition allowed).
    const session = this.sessionService.getSession(task.sessionId)
    if (session && session.status === 'queued') {
      try {
        this.sessionService.updateSession(task.sessionId, { status: 'processing' })
      } catch (err) {
        console.error(`[TaskQueue] Failed to transition session to processing:`, err)
      }
    }

    // Mark as running
    this.repository.update(task.id, {
      status: 'running',
      startedAt: new Date().toISOString()
    })

    // Set up watchdog with AbortController
    const controller = new AbortController()
    const audioDurationSec = this.getAudioDurationSec(task)
    const watchdog = new ProcessWatchdog({
      taskType: task.type,
      audioDurationSec,
      onStall: () => controller.abort()
    })

    const onProgress = (progress: number): void => {
      watchdog.heartbeat()
      this.repository.update(task.id, { progress })
      sendToRenderer('task:progress', {
        sessionId: task.sessionId,
        taskType: task.type,
        progress
      })
    }

    const runtime = {
      setAudioDurationSec: (sec: number): void => {
        watchdog.setAudioDurationSec(sec)
      }
    }

    watchdog.start()

    try {
      await executor.execute(task, onProgress, controller.signal, runtime)

      // Mark completed
      this.repository.update(task.id, {
        status: 'completed',
        progress: 1,
        completedAt: new Date().toISOString()
      })

      console.log(`[TaskQueue] Task ${task.type} completed for session ${task.sessionId}`)

      // Update session status based on completed task
      this.handleTaskCompletion(task)

      // Notify renderer
      sendToRenderer('task:completed', {
        sessionId: task.sessionId,
        taskType: task.type
      })
    } catch (error) {
      const errorMessage = controller.signal.aborted
        ? 'Verarbeitung reagiert nicht mehr'
        : error instanceof Error
          ? error.message
          : String(error)
      console.error(
        `[TaskQueue] Task ${task.type} failed for session ${task.sessionId}:`,
        errorMessage
      )

      this.repository.update(task.id, {
        status: 'failed',
        error: errorMessage,
        completedAt: new Date().toISOString()
      })

      this.handleTaskFailure(task, errorMessage)
    } finally {
      watchdog.stop()
      this.processing = false

      // Process next task (use setTimeout to avoid stack overflow on long chains)
      if (!this.shouldStop) {
        setTimeout(() => this.scheduleNext(), 0)
      }
    }
  }

  private getAudioDurationSec(task: Task): number | undefined {
    // Both transcription and diarization use audioDuration-based dynamic stall
    // thresholds (whisper: duration/40 for 5%-progress gap, pyannote: duration/15
    // from Spike A datapoint).
    if (task.type !== 'transcription' && task.type !== 'diarization') return undefined
    try {
      const session = this.sessionService.getSession(task.sessionId)
      if (!session?.audioPath) return undefined
      const stats = statSync(session.audioPath)
      const WAV_HEADER_SIZE = 44
      return Math.max(0, stats.size - WAV_HEADER_SIZE) / (48000 * 2) // 48kHz 16-bit mono
    } catch {
      return undefined
    }
  }

  private handleTaskCompletion(task: Task): void {
    const remainingTasks = this.repository.findBySession(task.sessionId)
    const pendingOrRunning = remainingTasks.filter(
      (t) => t.status === 'pending' || t.status === 'running'
    )

    if (pendingOrRunning.length === 0) {
      // All tasks done — set final status. Reset retryCount on successful review
      // (DR-7: counter resets when the session reaches review).
      try {
        this.sessionService.updateSession(task.sessionId, {
          status: 'review',
          retryCount: 0
        })
      } catch (err) {
        console.error(`[TaskQueue] Failed to transition session ${task.sessionId} to review:`, err)
      }
    }
    // While tasks remain pending, the session stays in 'processing'.
    // The actual current step is conveyed via task:started IPC events (Phase D).
  }

  private handleTaskFailure(task: Task, errorMessage: string): void {
    // Cancel remaining pending tasks for this session
    const cancelled = this.repository.cancelPendingForSession(task.sessionId)
    if (cancelled > 0) {
      console.log(`[TaskQueue] Cancelled ${cancelled} pending tasks for session ${task.sessionId}`)
    }

    // Set session to error state
    try {
      this.sessionService.updateSession(task.sessionId, {
        status: 'error',
        errorMessage
      })
    } catch (err) {
      console.error(
        `[TaskQueue] Failed to set session ${task.sessionId} to error state:`,
        err
      )
    }

    // Notify renderer
    sendToRenderer('task:error', {
      sessionId: task.sessionId,
      taskType: task.type,
      error: errorMessage
    })
  }

  private startPeriodicRecovery(): void {
    this.stopPeriodicRecovery()
    this.recoveryTimer = setInterval(() => {
      if (this.processing || this.shouldStop) return
      try {
        const stuck = this.recoverStuckTasks()
        const orphaned = this.recoverOrphanedSessions()
        if (stuck > 0 || orphaned > 0) {
          console.log(
            `[TaskQueue] Periodic recovery: ${stuck} stuck tasks, ${orphaned} orphaned sessions`
          )
          this.scheduleNext()
        }
      } catch (err) {
        console.error('[TaskQueue] Periodic recovery failed:', err)
      }
    }, RECOVERY_INTERVAL_MS)
  }

  private stopPeriodicRecovery(): void {
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer)
      this.recoveryTimer = null
    }
  }
}

// Singleton
let taskQueueService: TaskQueueService | null = null

export function initTaskQueue(db: Database.Database): TaskQueueService {
  if (taskQueueService) return taskQueueService
  taskQueueService = new TaskQueueService(db)
  return taskQueueService
}

export function getTaskQueue(): TaskQueueService {
  if (!taskQueueService) {
    throw new Error('TaskQueueService not initialized. Call initTaskQueue() first.')
  }
  return taskQueueService
}
