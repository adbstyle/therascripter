import type Database from 'better-sqlite3'
import { TaskRepository } from '../db/repositories/TaskRepository'
import { SessionService } from './SessionService'
import type { TaskExecutor } from './task-executors'
import { createStubExecutors } from './task-executors'
import { sendToRenderer } from '../utils/ipc-helpers'
import type { Task, TaskType, SessionStatus, SessionType } from '../../shared/types'

const AUDIO_PIPELINE: TaskType[] = ['transcription', 'diarization', 'alignment', 'anonymization']
const PDF_PIPELINE: TaskType[] = ['extraction', 'ocr', 'anonymization']

// Maps a completed task type to the next session status
const TASK_TO_SESSION_STATUS: Partial<Record<TaskType, SessionStatus>> = {
  transcription: 'diarizing',
  diarization: 'anonymizing',
  alignment: 'anonymizing',
  extraction: 'anonymizing',
  ocr: 'anonymizing',
  anonymization: 'review'
}

export class TaskQueueService {
  private repository: TaskRepository
  private sessionService: SessionService
  private executors: Map<TaskType, TaskExecutor>
  private processing = false
  private shouldStop = false

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

    // Kick off processing if not already running
    this.scheduleNext()

    return tasks
  }

  getSessionTasks(sessionId: string): Task[] {
    return this.repository.findBySession(sessionId)
  }

  recoverStuckTasks(): number {
    return this.repository.resetRunningToPending()
  }

  /** Find sessions stuck in a processing state with no pending/running tasks and mark as error */
  recoverOrphanedSessions(): number {
    const processingStatuses: SessionStatus[] = [
      'extracting',
      'transcribing',
      'diarizing',
      'anonymizing'
    ]
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
          recovered++
        } catch {
          // Best effort
        }
      }
    }

    return recovered
  }

  start(): void {
    this.shouldStop = false
    this.scheduleNext()
  }

  stop(): void {
    this.shouldStop = true
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

    const executor = this.executors.get(task.type)
    if (!executor) {
      this.repository.update(task.id, {
        status: 'failed',
        error: `No executor registered for task type: ${task.type}`,
        completedAt: new Date().toISOString()
      })
      this.handleTaskFailure(task, `No executor registered for task type: ${task.type}`)
      this.processing = false
      this.scheduleNext()
      return
    }

    // Mark as running
    this.repository.update(task.id, {
      status: 'running',
      startedAt: new Date().toISOString()
    })

    try {
      await executor.execute(task, (progress: number) => {
        // Update DB progress
        this.repository.update(task.id, { progress })
        // Notify renderer
        sendToRenderer('task:progress', {
          sessionId: task.sessionId,
          taskType: task.type,
          progress
        })
      })

      // Mark completed
      this.repository.update(task.id, {
        status: 'completed',
        progress: 1,
        completedAt: new Date().toISOString()
      })

      // Update session status based on completed task
      this.handleTaskCompletion(task)

      // Notify renderer
      sendToRenderer('task:completed', {
        sessionId: task.sessionId,
        taskType: task.type
      })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)

      this.repository.update(task.id, {
        status: 'failed',
        error: errorMessage,
        completedAt: new Date().toISOString()
      })

      this.handleTaskFailure(task, errorMessage)
    }

    this.processing = false

    // Process next task (use setTimeout to avoid stack overflow on long chains)
    if (!this.shouldStop) {
      setTimeout(() => this.scheduleNext(), 0)
    }
  }

  private handleTaskCompletion(task: Task): void {
    const nextStatus = TASK_TO_SESSION_STATUS[task.type]
    if (!nextStatus) return

    // Only transition if this is the last task of its kind for the session
    // (e.g., don't transition to 'anonymizing' after 'diarization' if 'alignment' is still pending)
    const remainingTasks = this.repository.findBySession(task.sessionId)
    const pendingOrRunning = remainingTasks.filter(
      (t) => t.status === 'pending' || t.status === 'running'
    )

    if (pendingOrRunning.length === 0) {
      // All tasks done — set final status
      try {
        this.sessionService.updateSession(task.sessionId, { status: 'review' })
      } catch {
        // Status transition may fail if already in target state
      }
    } else {
      // Determine next status from the next pending task type
      const nextTask = pendingOrRunning[0]
      const statusForNextTask = this.getSessionStatusForTask(nextTask.type)
      if (statusForNextTask) {
        try {
          this.sessionService.updateSession(task.sessionId, { status: statusForNextTask })
        } catch {
          // Status transition may fail if already in target state
        }
      }
    }
  }

  private getSessionStatusForTask(taskType: TaskType): SessionStatus | null {
    const mapping: Partial<Record<TaskType, SessionStatus>> = {
      transcription: 'transcribing',
      diarization: 'diarizing',
      alignment: 'diarizing', // alignment is part of diarization phase
      extraction: 'extracting',
      ocr: 'extracting',
      anonymization: 'anonymizing'
    }
    return mapping[taskType] ?? null
  }

  private handleTaskFailure(task: Task, errorMessage: string): void {
    // Set session to error state
    try {
      this.sessionService.updateSession(task.sessionId, {
        status: 'error',
        errorMessage
      })
    } catch {
      // Best effort
    }

    // Notify renderer
    sendToRenderer('task:error', {
      sessionId: task.sessionId,
      taskType: task.type,
      error: errorMessage
    })
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
