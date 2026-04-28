import type { Task } from '../../shared/types'
import type { TaskExecutor } from '../services/task-executors'

export interface SummarizationExecutorDeps {
  llamaSummarizer: {
    summarize(text: string, signal: AbortSignal): Promise<{ title: string; text: string }>
  }
  sessionService: {
    getAnonymizedPlainText(sessionId: string): string
    saveGeneratedSummary(sessionId: string, title: string, text: string, modelId: string): unknown
  }
  isModelInstalled: () => boolean
  getActiveModelId: () => string
  logger: { info(msg: string): void; error(msg: string): void }
}

export class SummarizationExecutor implements TaskExecutor {
  constructor(private readonly deps: SummarizationExecutorDeps) {}

  async execute(task: Task, _onProgress: (progress: number) => void, signal?: AbortSignal): Promise<void> {
    if (!this.deps.isModelInstalled()) {
      this.deps.logger.info(
        `Summarization skipped for session ${task.sessionId}: model not installed`
      )
      return
    }

    let text: string
    try {
      text = this.deps.sessionService.getAnonymizedPlainText(task.sessionId)
    } catch (err) {
      // Anonymized doc may be missing for older or partially-processed sessions —
      // skip silently rather than fail the whole task and turn the session into 'error'.
      this.deps.logger.info(
        `Summarization skipped for session ${task.sessionId}: ${err instanceof Error ? err.message : String(err)}`
      )
      return
    }

    if (!text || text.trim().length === 0) {
      this.deps.logger.info(
        `Summarization skipped for session ${task.sessionId}: empty anonymized text`
      )
      return
    }

    let result: { title: string; text: string }
    try {
      result = await this.deps.llamaSummarizer.summarize(
        text,
        signal ?? new AbortController().signal
      )
    } catch (err) {
      // Summarization is an OPTIONAL pipeline tail step. Any failure
      // (subprocess crash, abort, JSON-extraction failure, schema
      // validation failure, transient model error) must NOT poison the
      // whole session into 'error' state — the anonymized transcript
      // upstream is intact and the user should still reach the Review
      // Editor. Log + return cleanly; the task succeeds with
      // sessions.summary staying NULL.
      this.deps.logger.error(
        `Summarization failed for session ${task.sessionId}: ${err instanceof Error ? err.message : String(err)}`
      )
      return
    }

    this.deps.sessionService.saveGeneratedSummary(
      task.sessionId,
      result.title,
      result.text,
      this.deps.getActiveModelId()
    )
  }
}
