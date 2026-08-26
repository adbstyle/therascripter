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
import { getActiveModelId } from './ModelDownloadService'
import { captureProcessedModels } from './ProvenanceCapture'

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
 *   - ocr (PDF only): always included. The executor self-skips when extraction
 *     reports no scanned pages, so the cost for text-only PDFs is one no-op
 *     task. Previously gated on the import-time pdfHasScannedPages heuristic,
 *     but that heuristic samples only the first 3 pages and could disagree
 *     with extraction-time per-page detection, leaving partially-scanned PDFs
 *     stuck without a transcriptPath when extraction discovered scanned pages
 *     beyond the sample window.
 */
export function computePlannedSteps(session: Session): TaskType[] {
  // getActiveModelId already verifies disk presence and returns null on
  // missing/unknown — so a non-null result implies the model is installed
  // and the executor has a real path to work with.
  const summarizationActive = getActiveModelId('summarization') !== null

  if (session.type === 'audio') {
    return AUDIO_PIPELINE.filter((step) => step !== 'summarization' || summarizationActive)
  }

  return PDF_PIPELINE.filter((step) => step !== 'summarization' || summarizationActive)
}

export class TaskQueueService {
  private repository: TaskRepository
  private sessionService: SessionService
  private executors: Map<TaskType, TaskExecutor>
  /** Max. Crash-Recoveries pro Task, bevor er als Poison-Task failed (016). */
  private static readonly MAX_BOOT_RECOVERY_ATTEMPTS = 2

  private processing = false
  private shouldStop = false
  // Während einer laufenden Aufnahme startet die Queue keine neuen Tasks
  // (kein Lüfterlärm in der Therapiesitzung); ein bereits laufender Task
  // läuft aus. In-memory: App-Neustart startet unpausiert.
  private pausedForRecording = false
  private recoveryTimer: ReturnType<typeof setInterval> | null = null
  // Tracks the AbortController for the currently running task so that
  // abortRunningForSession() (called from SessionService.deleteSession) can
  // signal the executor to stop cleanly. See DR-6 in plans/2026-04-29-pipeline-progress-ui-issue-80.md.
  private runningController: { sessionId: string; controller: AbortController } | null = null

  constructor(private readonly db: Database.Database) {
    this.repository = new TaskRepository(db)
    this.sessionService = new SessionService(db)
    this.executors = createStubExecutors()
  }

  registerExecutor(type: TaskType, executor: TaskExecutor): void {
    this.executors.set(type, executor)
  }

  enqueuePipeline(sessionId: string, sessionType: SessionType): Task[] {
    const session = this.sessionService.getSession(sessionId)
    if (!session) {
      throw new Error(`Session ${sessionId} not found in enqueuePipeline`)
    }

    // Issue #80: filter the pipeline through computePlannedSteps and freeze
    // the result on the session. This is the single source of truth for
    //   - which tasks get enqueued (here)
    //   - the renderer's "Schritt N/M" counter (via task:started)
    //   - retrySession's resume slice
    // Previously enqueuePipeline used the raw AUDIO_PIPELINE / PDF_PIPELINE
    // constants while computePlannedSteps filtered them, causing a brief
    // "Schritt 0/N" flicker for filtered-out tasks (summarization without
    // model installed, ocr on text-only PDFs).
    const plannedSteps = computePlannedSteps(session)
    // Issue #84 Story I — capture-at-source: snapshot the active models per
    // group for this run so the Review-Editor can show provenance later.
    // Done together with plannedSteps so both states are consistent.
    const processedWithModels = captureProcessedModels(plannedSteps)

    // Transaktional: ein Throw mitten im Task-Insert hinterließ vorher eine
    // Partial-Pipeline (z. B. nur diarization+transcription), die bis
    // 'review' durchlief — ohne Anonymisierung.
    const tasks = this.db.transaction(() => {
      this.sessionService.updateSession(sessionId, { plannedSteps, processedWithModels })
      const created: Task[] = []
      for (const type of plannedSteps) {
        created.push(this.repository.create({ sessionId, type }))
      }
      return created
    })()

    console.log(
      `[TaskQueue] Enqueued ${plannedSteps.length} tasks for session ${sessionId} (${sessionType}) — ${plannedSteps.join(',')}`
    )

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

    // Issue #80: slice from session.plannedSteps (frozen at first enqueue) so
    // retry honours the same filter the original run used (no OCR re-add for
    // text-only PDFs, no summarization re-add when no model installed).
    // Legacy session rows from before Phase H have null plannedSteps —
    // recompute now and freeze so processNext doesn't drift.
    const pipeline = session.plannedSteps ?? computePlannedSteps(session)
    const resumeIndex = this.findResumeIndex(session, pipeline)

    // Issue #84 Story I — re-capture provenance: the user may have switched
    // the active model between runs; the relevant snapshot is what actually
    // produces the next attempt, not the previous failed one.
    const processedWithModels = captureProcessedModels(pipeline)
    const remainingSteps = pipeline.slice(resumeIndex)

    // Transaktional wie enqueuePipeline: delete + create + Status-Update
    // sind alles-oder-nichts, sonst kann ein Crash mid-retry eine Session
    // in 'error' mit halb neu erzeugten Tasks hinterlassen.
    this.db.transaction(() => {
      // Remove all non-completed task rows (failed + cancelled)
      const deleted = this.repository.deleteNonCompletedForSession(sessionId)
      if (deleted > 0) {
        console.log(`[TaskQueue] Deleted ${deleted} non-completed tasks for session ${sessionId}`)
      }

      // Create pending tasks for remaining pipeline steps
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
        retryCount: (session.retryCount ?? 0) + 1,
        plannedSteps: pipeline,
        processedWithModels
      })
    })()

    console.log(
      `[TaskQueue] Retrying session ${sessionId} from step ${remainingSteps[0]} ` +
        `(skipping ${resumeIndex} completed step(s))`
    )

    this.scheduleNext()
  }

  private findResumeIndex(session: Session, pipeline: readonly TaskType[]): number {
    // Maps each task type to the session field that proves it completed successfully.
    // PDF extraction's success is gated on BOTH extractedPath AND transcriptPath:
    // pre-fix sessions could end up with extractedPath set but transcriptPath
    // missing, which used to wedge retries at anonymization. Treating the pair
    // as a single proof restarts those sessions from extraction on retry.
    const extractionOutput =
      session.extractedPath && session.transcriptPath ? session.extractedPath : null
    const outputField: Partial<Record<TaskType, string | null>> = {
      transcription: session.transcriptPath,
      diarization: session.diarizationPath,
      alignment: session.alignedTranscriptPath,
      extraction: extractionOutput,
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
    // Boot-Recovery mit Poison-Erkennung: ein Task, der bereits
    // MAX_BOOT_RECOVERY_ATTEMPTS mal nach einem Crash zurückgesetzt wurde
    // und WIEDER als 'running' vorgefunden wird, crasht die App
    // reproduzierbar (z. B. nativer OOM) — erneutes pending würde eine
    // endlose Crash-Schleife erzeugen. Sauberer Shutdown zählt nicht:
    // shutdown() setzt selbst auf pending zurück, ohne attempts zu erhöhen.
    const running = this.repository.findRunning()
    for (const task of running) {
      const attempts = task.attempts + 1
      if (attempts > TaskQueueService.MAX_BOOT_RECOVERY_ATTEMPTS) {
        const message =
          'Dieser Verarbeitungsschritt ist mehrfach unerwartet abgebrochen. ' +
          'Bitte versuchen Sie es mit "Erneut versuchen" — tritt der Fehler erneut auf, ' +
          'starten Sie die App neu oder kontaktieren Sie den Support.'
        this.repository.update(task.id, {
          status: 'failed',
          error: message,
          completedAt: new Date().toISOString(),
          attempts
        })
        this.handleTaskFailure(task, message)
        console.warn(
          `[TaskQueue] Task ${task.type} für Session ${task.sessionId} nach ${attempts} Boot-Recoveries poisoned`
        )
      } else {
        this.repository.update(task.id, {
          status: 'pending',
          startedAt: null,
          progress: 0,
          attempts
        })
      }
    }
    return running.length
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
          console.log(
            `[TaskQueue] Recovered orphaned session ${session.id} (was ${session.status})`
          )
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

  /**
   * Geordneter Shutdown für before-quit: stoppt die Queue, abortet den
   * laufenden Executor (killt damit den ML-Subprozess über runSubprocess)
   * und wartet bounded, bis processNext gesettelt hat — erst danach darf
   * die DB geschlossen werden. Vorher überlebten whisper/python/llama den
   * App-Exit und der Executor schrieb in eine bereits geschlossene DB.
   */
  async shutdown(timeoutMs = 8_000): Promise<void> {
    this.shouldStop = true
    this.stopPeriodicRecovery()
    this.runningController?.controller.abort()
    const deadline = Date.now() + timeoutMs
    while (this.processing && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  isProcessing(): boolean {
    return this.processing
  }

  /**
   * Pausiert/resumt die Queue für die Dauer einer Aufnahme. Greift im
   * processNext()-Guard, also zwischen Pipeline-Steps — jeder Step
   * (whisper/pyannote/flair/llama) ist rechenintensiv. Idempotent.
   */
  setRecordingPause(paused: boolean): void {
    if (this.pausedForRecording === paused) return
    this.pausedForRecording = paused
    console.log(`[TaskQueue] Recording pause ${paused ? 'ON' : 'OFF'}`)
    if (!paused) this.scheduleNext()
  }

  /** Fire-and-forget wrapper that swallows rejections during shutdown */
  private scheduleNext(): void {
    this.processNext().catch(() => {
      // Swallow errors during shutdown (e.g., DB closed)
    })
  }

  private async processNext(): Promise<void> {
    if (this.processing || this.shouldStop || this.pausedForRecording) return

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
    // plannedSteps is normally already frozen by enqueuePipeline; fall back to
    // computePlannedSteps only for legacy migration rows that have null plannedSteps.
    const session = this.sessionService.getSession(task.sessionId)
    if (session && session.status === 'queued') {
      const plannedSteps = session.plannedSteps ?? computePlannedSteps(session)
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

    // Issue #80 / Phase D — emit task:started with stepIndex/totalSteps
    // derived from session.plannedSteps. The renderer uses this to avoid
    // predicting the next task locally (DR-2).
    const sessionForPlan = this.sessionService.getSession(task.sessionId)
    const plannedSteps = sessionForPlan?.plannedSteps ?? []
    const stepIndex = plannedSteps.indexOf(task.type) + 1 // 1-based; 0 if missing
    const totalSteps = plannedSteps.length

    sendToRenderer('task:started', {
      sessionId: task.sessionId,
      taskType: task.type,
      stepIndex,
      totalSteps
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
          progress
        })
      }
    }

    const runtime = {
      setAudioDurationSec: (sec: number): void => {
        watchdog.setAudioDurationSec(sec)
      },
      // Lebenszeichen ohne Fortschritt: kein repository.update, kein
      // task:progress-Event — der Renderer soll nicht bei jedem Herzschlag
      // eines still ladenden Modells neu rendern.
      heartbeat: (): void => {
        watchdog.heartbeat()
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
      // Shutdown-Abort ist kein Fehler: Task zurück auf pending, damit der
      // nächste Start ihn nahtlos fortsetzt. failed + session:error würde
      // dem User nach jedem Quit-mit-laufendem-Task einen Retry zeigen.
      if (this.shouldStop && controller.signal.aborted) {
        try {
          this.repository.update(task.id, {
            status: 'pending',
            progress: 0,
            startedAt: null
          })
        } catch (resetErr) {
          console.error('[TaskQueue] Shutdown-Reset des Tasks fehlgeschlagen:', resetErr)
        }
        console.log(
          `[TaskQueue] Task ${task.type} für Session ${task.sessionId} beim Shutdown auf pending zurückgesetzt`
        )
        return
      }

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
    const session = this.sessionService.getSession(task.sessionId)

    // Review-Ungating: die Session erreicht 'review', sobald die
    // Anonymisierung abgeschlossen ist — der Editor lädt nur das
    // anonymisierte Dokument. Die optionale Summarization läuft danach im
    // Hintergrund weiter; ihr task:completed-Event triggert den
    // Renderer-Refetch, der die fertige Summary nachlädt. Der User spart
    // die volle llama-Inferenzzeit (30–120 s) bis zum Editor.
    // retryCount-Reset (DR-7) passiert hier — review ist erreicht.
    if (task.type === 'anonymization' && session?.status === 'processing') {
      try {
        this.sessionService.updateSession(task.sessionId, {
          status: 'review',
          retryCount: 0
        })
      } catch (err) {
        console.error(`[TaskQueue] Failed to transition session ${task.sessionId} to review:`, err)
      }
      return
    }

    const remainingTasks = this.repository.findBySession(task.sessionId)
    const pendingOrRunning = remainingTasks.filter(
      (t) => t.status === 'pending' || t.status === 'running'
    )

    // Fallback für Pipelines ohne Anonymisierungs-Step (defensiv — aktuell
    // enthalten beide Pipelines anonymization). Guard auf 'processing'
    // verhindert die ungültige review→review-Transition, wenn die
    // Hintergrund-Summarization nach dem Ungating abschließt.
    if (pendingOrRunning.length === 0 && session?.status === 'processing') {
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
    // Summarization-Invariante (CLAUDE.md): Fehler dieses Steps dürfen NIE
    // die Session erroren — die Session ist beim Ungating bereits in
    // 'review', ein review→error würde das fertig anonymisierte Transkript
    // hinter einem Retry-Button verstecken. Summary bleibt einfach NULL.
    // (Der Executor failt ohnehin soft; hierher gelangt nur der
    // Watchdog-/Poison-Pfad.)
    if (task.type === 'summarization') {
      console.warn(
        `[TaskQueue] Summarization für Session ${task.sessionId} fehlgeschlagen (${errorMessage}) — Session bleibt in review, Summary bleibt leer`
      )
      return
    }

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
      console.error(`[TaskQueue] Failed to set session ${task.sessionId} to error state:`, err)
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
