import { describe, it, expect, vi } from 'vitest'
import { SummarizationExecutor } from '../SummarizationExecutor'
import type { Task } from '../../../shared/types'
import { ToolBlockedError } from '../../../shared/tool-blocked'

const ENTITY_MAP = {
  'person-1': {
    original: 'Ruth Gerber',
    placeholder: '[PERSON 1]',
    type: 'PERSON' as const,
    source: 'ner' as const
  }
}

const makeDeps = (
  over: {
    llamaSummarizer?: { summarize?: ReturnType<typeof vi.fn> }
    sessionService?: {
      getAnonymizedPlainText?: ReturnType<typeof vi.fn>
      getEntityMap?: ReturnType<typeof vi.fn>
      saveGeneratedSummary?: ReturnType<typeof vi.fn>
    }
    isModelInstalled?: () => boolean
    getActiveModelId?: () => string | null
  } = {}
): {
  llamaSummarizer: { summarize: ReturnType<typeof vi.fn> }
  sessionService: {
    getAnonymizedPlainText: ReturnType<typeof vi.fn>
    getEntityMap: ReturnType<typeof vi.fn>
    saveGeneratedSummary: ReturnType<typeof vi.fn>
  }
  isModelInstalled: () => boolean
  getActiveModelId: () => string | null
  logger: { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> }
} => ({
  llamaSummarizer: {
    summarize:
      over.llamaSummarizer?.summarize ??
      vi.fn().mockResolvedValue({ title: 'Kurztitel', text: 'Eine Zusammenfassung.' })
  },
  sessionService: {
    getAnonymizedPlainText:
      over.sessionService?.getAnonymizedPlainText ??
      vi.fn().mockReturnValue('Der Patient war müde.'),
    getEntityMap: over.sessionService?.getEntityMap ?? vi.fn().mockReturnValue(ENTITY_MAP),
    saveGeneratedSummary: over.sessionService?.saveGeneratedSummary ?? vi.fn()
  },
  isModelInstalled: over.isModelInstalled ?? ((): boolean => true),
  getActiveModelId: over.getActiveModelId ?? ((): string | null => 'gemma-4-e2b-summarization'),
  logger: { info: vi.fn(), error: vi.fn() }
})

const task = { id: 't1', type: 'summarization', sessionId: 'abc' } as Task
const onProgress = (): void => {}
const signal = new AbortController().signal

describe('SummarizationExecutor', () => {
  it('skips cleanly when model is not installed', async () => {
    const deps = makeDeps({ isModelInstalled: () => false })
    const exec = new SummarizationExecutor(deps)
    await expect(exec.execute(task, onProgress, signal)).resolves.toBeUndefined()
    expect(deps.llamaSummarizer.summarize).not.toHaveBeenCalled()
    expect(deps.sessionService.saveGeneratedSummary).not.toHaveBeenCalled()
    expect(deps.logger.info).toHaveBeenCalledWith(expect.stringMatching(/skip.*model/i))
  })

  it('summarizes anonymized text and persists title + text with active model id', async () => {
    const deps = makeDeps()
    const exec = new SummarizationExecutor(deps)
    await exec.execute(task, onProgress, signal)
    expect(deps.llamaSummarizer.summarize).toHaveBeenCalledWith('Der Patient war müde.', signal)
    expect(deps.sessionService.saveGeneratedSummary).toHaveBeenCalledWith(
      'abc',
      'Kurztitel',
      'Eine Zusammenfassung.',
      'gemma-4-e2b-summarization',
      ENTITY_MAP
    )
  })

  it('#203: records the EntityMap read with the text, not the one at save time', async () => {
    const getEntityMap = vi.fn().mockReturnValue(ENTITY_MAP)
    let resolveSummary: (v: { title: string; text: string }) => void = () => {}
    const deps = makeDeps({
      llamaSummarizer: {
        summarize: vi.fn(() => new Promise((resolve) => (resolveSummary = resolve)))
      },
      sessionService: { getEntityMap }
    })
    const exec = new SummarizationExecutor(deps)
    const run = exec.execute(task, onProgress, signal)
    await Promise.resolve()
    // The user edits while the model runs — the EntityMap changes meanwhile
    getEntityMap.mockReturnValue({})
    resolveSummary({ title: '[PERSON 1]', text: 'Mit [PERSON 1].' })
    await run
    expect(getEntityMap).toHaveBeenCalledTimes(1)
    expect(deps.sessionService.saveGeneratedSummary).toHaveBeenCalledWith(
      'abc',
      '[PERSON 1]',
      'Mit [PERSON 1].',
      'gemma-4-e2b-summarization',
      ENTITY_MAP
    )
  })

  it('swallows summarizer errors as a graceful skip (does NOT poison the session)', async () => {
    // Architectural contract: summarization is an OPTIONAL pipeline tail
    // step. Per the plan ("Model-missing is a skip, not a failure"), ANY
    // failure (subprocess crash, abort, JSON-extraction failure, schema
    // validation failure) must NOT propagate to the TaskQueue — that would
    // mark the task failed, set session.status='error', and hide the
    // already-anonymized transcript behind a Retry button.
    const deps = makeDeps({
      llamaSummarizer: { summarize: vi.fn().mockRejectedValue(new Error('spawn failed')) }
    })
    const exec = new SummarizationExecutor(deps)
    await expect(exec.execute(task, onProgress, signal)).resolves.toBeUndefined()
    expect(deps.sessionService.saveGeneratedSummary).not.toHaveBeenCalled()
    expect(deps.logger.error).toHaveBeenCalledWith(expect.stringMatching(/spawn failed/))
  })

  it('skips cleanly when anonymized text is empty', async () => {
    const deps = makeDeps({
      sessionService: { getAnonymizedPlainText: vi.fn().mockReturnValue('') }
    })
    const exec = new SummarizationExecutor(deps)
    await expect(exec.execute(task, onProgress, signal)).resolves.toBeUndefined()
    expect(deps.llamaSummarizer.summarize).not.toHaveBeenCalled()
    expect(deps.sessionService.saveGeneratedSummary).not.toHaveBeenCalled()
  })

  it('skips when getAnonymizedPlainText throws (e.g. missing anonymized doc)', async () => {
    const deps = makeDeps({
      sessionService: {
        getAnonymizedPlainText: vi.fn(() => {
          throw new Error('no anonymized doc')
        })
      }
    })
    const exec = new SummarizationExecutor(deps)
    await expect(exec.execute(task, onProgress, signal)).resolves.toBeUndefined()
    expect(deps.llamaSummarizer.summarize).not.toHaveBeenCalled()
    expect(deps.sessionService.saveGeneratedSummary).not.toHaveBeenCalled()
    expect(deps.logger.info).toHaveBeenCalledWith(expect.stringMatching(/skip/i))
  })
})

describe('SummarizationExecutor — blockiertes Werkzeug (#168)', () => {
  it('überspringt nicht still: der Fehler geht an die Warteschlange (Sitzung bleibt im Review)', async () => {
    const deps = makeDeps({
      llamaSummarizer: {
        summarize: vi.fn().mockRejectedValue(new ToolBlockedError('llama', false))
      }
    })
    const exec = new SummarizationExecutor(deps)
    await expect(exec.execute(task, onProgress, signal)).rejects.toBeInstanceOf(ToolBlockedError)
    expect(deps.sessionService.saveGeneratedSummary).not.toHaveBeenCalled()
  })
})
