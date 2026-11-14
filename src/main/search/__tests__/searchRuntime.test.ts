import { describe, it, expect, vi } from 'vitest'
import { semanticAvailabilityOf } from '../searchRuntime'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp/therascript-test', getAppPath: () => '/tmp' },
  BrowserWindow: { getAllWindows: () => [] }
}))

describe('semanticAvailabilityOf', () => {
  it('maps the search process state to SearchAvailability.semantic', () => {
    expect(semanticAvailabilityOf({ phase: 'stopped', reason: null })).toBe('ready')
    expect(semanticAvailabilityOf({ phase: 'starting', reason: null })).toBe('loading')
    expect(semanticAvailabilityOf({ phase: 'busy', reason: null })).toBe('ready')
    expect(semanticAvailabilityOf({ phase: 'starting', reason: 'processing' })).toBe(
      'unavailable-processing'
    )
    expect(semanticAvailabilityOf({ phase: 'stopped', reason: 'model-missing' })).toBe(
      'model-missing'
    )
    expect(semanticAvailabilityOf({ phase: 'stopped', reason: 'tool-blocked' })).toBe(
      'tool-blocked'
    )
    expect(semanticAvailabilityOf({ phase: 'stopped', reason: 'error' })).toBe('error')
  })
})

describe('resolveSearchModel', () => {
  it('reads location from the override and prompts/dimension from the catalog, also unpublished', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('fs')
    const { join } = await import('path')
    const { tmpdir } = await import('os')
    const { resolveSearchModel } = await import('../searchModel')
    const dir = mkdtempSync(join(tmpdir(), 'search-model-'))
    const before = process.env.THERASCRIPT_SEARCH_MODEL_DIR
    process.env.THERASCRIPT_SEARCH_MODEL_DIR = dir
    try {
      expect(resolveSearchModel()).toBeNull()
      writeFileSync(join(dir, 'READY'), '')
      expect(resolveSearchModel()).toEqual({
        dir,
        modelId: 'embeddinggemma-2-text',
        dim: 768,
        queryPrompt: 'task: search result | query: ',
        documentPrompt: 'title: none | text: ',
        maxTokens: 1024,
        padMultiple: 128
      })
    } finally {
      if (before === undefined) delete process.env.THERASCRIPT_SEARCH_MODEL_DIR
      else process.env.THERASCRIPT_SEARCH_MODEL_DIR = before
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
