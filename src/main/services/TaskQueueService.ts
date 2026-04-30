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
import { getActiveModelId, isModelInstalled } from './ModelDownloadService'
import { PipelineStatsService } from './PipelineStatsService'
import { PipelineEstimator, type SessionMeta } from './PipelineEstimator'
import { getSettings } from './SettingsService'
import { promises as fsp } from 'fs'

// Issue #80 / DR-5: tasks[] is the source of truth for "current step".
// SessionStatus only carries lifecycle phase (queued / processing / review / error / recording).
// The previous TASK_TO_SESSION_STATUS map and getSessionStatusForTask helper were removed.

const RECOVERY_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

/**
 * Issue #80 / Phases C+H — compute the planned (visible) pipeline steps for
 * a session. Frozen at queued → processing and stored in Session.plannedSteps;
 * the renderer reads this via task:started's totalSteps/stepIndex.
 *
 * Pipeline order is sourced from `src/shared/constants/pipeline.ts`
 * (CLAUDE.md: no local duplicate of the order).
 *
 * Conditional steps:
 *   - summarization: included iff a summarization model is configured AND
 *     installed on disk. The executor itself also gracefully skips at runtime
 *     if the model becomes unavailable, but we omit it from plannedSteps so
 *     the UI doesn't show a step that won't actually do anything.
 *   - ocr (PDF only): included iff session.pdfHasScannedPages === true (set
 *     at import time by the PDF importer's heuristic — Phase G).
 */
export function computePlannedSteps(session: Session): TaskType[] {
  const summarizationActive = (() => {
    try {
      const id = getActiveModelId('summarization')
      return id.length > 0 && isModelInstalled(id)
    } catch {
      return false
    }
  })()

  if (session.type === 'audio') {
    return AUDIO_PIPELINE.filter((step) => step !== 'summarization' || summarizationActive)
  }

  // PDF: include ocr only when import-time detection said scanned pages exist.
  // Phase G adds the pdfHasScannedPages column; until then it's always undefined
  // and OCR is omitted from plannedSteps (matching today's PDF UI behaviour).
  const hasScannedPages =
    'pdfHasScannedPages' in session && (session as Session & { pdfHasScannedPages?: boolean }).pdfHasScannedPages === true
  return PDF_PIPELINE.filter((step) => {
    if (step === 'ocr') return hasScannedPages
    if (step === 'summarization') return summarizationActive
    return true
  })
}

export class TaskQueueService {
  private repository: TaskRepository
  private sessionService: SessionService
  private executors: Map<TaskType, TaskExecutor>
  private processing = false
  private shouldStop = false
  private recoveryTimer: ReturnType<typeof setInterval> | null = null
  // Tracks the AbortController for the currently running task so that
  // abortRunningForSession() (called from SessionService.deleteSession) can
  // signal the executor to stop cleanly. See DR-6 in plans/2026-04-29-pipeline-progress-ui-issue-80.md.
  private runningController: { sessionId: string; controller: AbortController } | null = null
  // Issue #80 Phase I — telemetry + ETA estimator. Lazy-init via getter so
  // tests that don't initSettings() first get an in-memory no-op service
  // instead of crashing on construction.
  private _stats: PipelineStatsService | null = null
  private _estimator: PipelineEstimator | null = null

  private get stats(): PipelineStatsService {
    if (this._stats) return this._stats
    try {
      this._stats = new PipelineStatsService(getSettings())
    } catch {
      // Settings store not initialised (typical in tests). Use an in-memory
      // store so estimator/stats remain functional but ephemeral.
      const memory: Record<string, unknown> = {}
      this._stats = new PipelineStatsService({
        get: ((key: string) => memory[key]) as never,
        set: ((key: string, value: unknown) => {
          memory[key] = value
        }) as never
      })
    }
    return this._stats
  }
  private get estimator(): PipelineEstimator {
    if (!this._estimator) this._estimator = new PipelineEstimator(this.stats)
    return this._estimator
  }

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

    // Phase D.4 — emit queue positions so waiting cards can render "Wartet — Position N"
    this.broadcastQueuePositions()

    // Kick off processing if not already running
    this.scheduleNext()

    return tasks
  }

  getSessionTasks(sessionId: string): Task[] {
    return this.repository.findBySession(sessionId)
  }

  /**
   * Aborts the running task (if any) for the given session and cancels all
   * pending tasks. Called from SessionService.deleteSession to ensure no
   * zombie executor remains after the session is removed.
   *
   * Idempotent: calling multiple times for the same session is safe.
   * If no task is running for the session, only pending cancellation runs.
   */
  abortRunningForSession(sessionId: string): void {
    if (this.runningController?.sessionId === sessionId) {
      this.runningController.controller.abort()
    }
    const cancelled = this.repository.cancelPendingForSession(sessionId)
    if (cancelled > 0) {
      console.log(
        `[TaskQueue] Cancelled ${cancelled} pending tasks for deleted session ${sessionId}`
      )
    }
    this.broadcastQueuePositions()
  }

  /**
   * Issue #80 / Phase D.4 — broadcasts the current queue positions to all
   * renderers so waiting cards can show "Wartet — Position N". Emitted on
   * every queue mutation (enqueue, completion, abort).
   *
   * Position is 1-based and ordered by createdAt ascending. Sessions in
   * 'recording' or already 'processing' are excluded from the queue map.
   */
  private broadcastQueuePositions(): void {
    const queued = this.sessionService
      .getAllSessions()
      .filter((s) => s.status === 'queued')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    const positions: Record<string, number> = {}
    queued.forEach((s, idx) => {
      positions[s.id] = idx + 1
    })
    sendToRenderer('queue:positions', { positions })
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
    // retry is in flight. Issue #80 DR-7: increment retryCount so the UI can
    // surface the 3-stage support hint after repeated failures.
    this.sessionService.updateSession(sessionId, {
      status: 'queued',
      errorMessage: null,
      retryCount: (session.retryCount ?? 0) + 1
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
    // Also: freeze plannedSteps for the renderer's step counter (DR-4 / Phase H).
    const session = this.sessionService.getSession(task.sessionId)
    if (session && session.status === 'queued') {
      const plannedSteps = computePlannedSteps(session)
      try {
        this.sessionService.updateSession(task.sessionId, {
          status: 'processing',
          plannedSteps
        })
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
    this.runningController = { sessionId: task.sessionId, controller }
    const audioDurationSec = this.getAudioDurationSec(task)
    const watchdog = new ProcessWatchdog({
      taskType: task.type,
      audioDurationSec,
      onStall: () => controller.abort()
    })

    // Issue #80 / Phase D + I — emit task:started with stepIndex/totalSteps
    // from plannedSteps (Phase D) and plannedDurationSec from the estimator
    // (Phase I, null when uncalibrated).
    const sessionForPlan = this.sessionService.getSession(task.sessionId)
    const plannedSteps = sessionForPlan?.plannedSteps ?? []
    const stepIndex = plannedSteps.indexOf(task.type) + 1 // 1-based; 0 if missing
    const totalSteps = plannedSteps.length

    // Build session meta once per task (used by both task:started and every
    // task:progress emit). audioSec uses the same WAV-size derivation as the
    // watchdog; pages is only read when relevant for the active step.
    const sessionMeta: SessionMeta = {
      audioSec: audioDurationSec,
      wordCount: sessionForPlan?.wordCount ?? undefined
    }
    if (task.type === 'extraction' || task.type === 'ocr') {
      const pages = await this.getPagesForSession(task.sessionId)
      if (pages != null) sessionMeta.pages = pages
    }

    const plannedDurationSec = this.estimator.isCalibrated()
      ? this.estimator.estimate(task.type, sessionMeta)
      : null
    sendToRenderer('task:started', {
      sessionId: task.sessionId,
      taskType: task.type,
      stepIndex,
      totalSteps,
      plannedDurationSec
    })

    // Issue #80 / Phase E.3 — backend-side throttle to ≤4 Hz so renderer can't
    // be overwhelmed by chatty executors (whisper-cli emits ~20 Hz from stderr).
    // Boundary values 0 and 1 always pass through.
    let lastProgressEmit = 0
    const PROGRESS_THROTTLE_MS = 250

    const onProgress = (progress: number): void => {
      watchdog.heartbeat()
      this.repository.update(task.id, { progress })
      const now = Date.now()
      if (progress === 0 || progress >= 1 || now - lastProgressEmit >= PROGRESS_THROTTLE_MS) {
        lastProgressEmit = now
        sendToRenderer('task:progress', {
          sessionId: task.sessionId,
          taskType: task.type,
          progress,
          etaSecondsTotal: this.estimator.totalEta(plannedSteps, task.type, progress, sessionMeta)
        })
      }
    }

    const runtime = {
      setAudioDurationSec: (sec: number): void => {
        watchdog.setAudioDurationSec(sec)
      }
    }

    watchdog.start()

    const startedAt = Date.now()
    try {
      await executor.execute(task, onProgress, controller.signal, runtime)

      // Mark completed
      this.repository.update(task.id, {
        status: 'completed',
        progress: 1,
        completedAt: new Date().toISOString()
      })

      console.log(`[TaskQueue] Task ${task.type} completed for session ${task.sessionId}`)

      // Issue #80 Phase I — record duration sample for the estimator.
      // Best-effort: a failure to record telemetry must not affect pipeline state.
      this.recordTelemetry(task, sessionMeta, (Date.now() - startedAt) / 1000).catch((err) =>
        console.warn(`[TaskQueue] Failed to record telemetry for ${task.type}:`, err)
      )

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
      this.runningController = null
      this.processing = false

      // Phase D.4 — task ended (success or fail), queue positions may have shifted
      this.broadcastQueuePositions()

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

  /**
   * Issue #80 Phase I — read PDF page count from extracted JSON.
   * Returns null if the file isn't yet written or can't be parsed.
   * Used both for ETA estimation (before extraction completes the count is
   * unknown) and for telemetry recording (after extraction the count is
   * authoritative).
   */
  private async getPagesForSession(sessionId: string): Promise<number | null> {
    const session = this.sessionService.getSession(sessionId)
    if (!session?.extractedPath) return null
    try {
      const raw = await fsp.readFile(session.extractedPath, 'utf8')
      const data = JSON.parse(raw)
      return Array.isArray(data?.pages) ? data.pages.length : null
    } catch {
      return null
    }
  }

  /**
   * Issue #80 Phase I — record a per-step duration sample for the estimator.
   * Routes to the right recorder based on the step's domain (audio /
   * wordCount / pages). Best-effort: skips silently if the relevant input
   * dimension is unknown for this session.
   */
  private async recordTelemetry(
    task: Task,
    meta: SessionMeta,
    durationSec: number
  ): Promise<void> {
    if (!Number.isFinite(durationSec) || durationSec <= 0) return

    switch (task.type) {
      case 'diarization':
      case 'transcription':
      case 'alignment': {
        if (meta.audioSec && meta.audioSec > 0) {
          this.stats.recordRate(task.type, meta.audioSec, durationSec)
        }
        return
      }
      case 'anonymization':
      case 'summarization': {
        // wordCount is set by anonymization, so summarization can read
        // the freshly persisted value via sessionService.
        const session = this.sessionService.getSession(task.sessionId)
        const wc = session?.wordCount ?? meta.wordCount
        if (wc != null && wc > 0) {
          this.stats.recordWords(task.type, wc, durationSec)
        }
        return
      }
      case 'extraction':
      case 'ocr': {
        const pages = await this.getPagesForSession(task.sessionId)
        if (pages != null && pages > 0) {
          this.stats.recordPages(task.type, pages, durationSec)
        }
        return
      }
      default:
        return
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
