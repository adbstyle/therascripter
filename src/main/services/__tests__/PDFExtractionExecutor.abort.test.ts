import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const state = vi.hoisted(() => ({ pdfPath: '', metadataPending: false }))

vi.mock('../../db/connection', () => ({
  getDatabase: () => ({}),
  getDataDir: () => '/mock/.therascript'
}))
vi.mock('../SessionService', () => ({
  SessionService: vi.fn().mockImplementation(() => ({
    getSession: () => ({ id: 's1', pdfPath: state.pdfPath }),
    updateSession: vi.fn()
  }))
}))
const mockWriteFileAtomic = vi.fn()
vi.mock('../../utils/file-ops', () => ({
  writeFileAtomic: (...args: unknown[]) => mockWriteFileAtomic(...args)
}))
const mockBuildTranscript = vi.fn()
vi.mock('../../utils/pdf-transcript-builder', () => ({
  buildPDFTranscript: (...args: unknown[]) => mockBuildTranscript(...args)
}))
vi.mock('../../utils/pdfjs-loader', () => ({
  openPdfDocument: async () => ({
    numPages: 1,
    getPage: async () => ({
      getTextContent: async () => ({ items: [{ str: 'x'.repeat(80), hasEOL: false }] })
    }),
    getMetadata: () => {
      state.metadataPending = true
      return new Promise(() => {}) // hangs, like a stuck pdf.js await
    }
  }),
  releasePdfDocument: vi.fn()
}))

import { PDFExtractionExecutor } from '../PDFExtractionExecutor'
import type { Task } from '../../../shared/types'

// Issue #202: once the session is deleted (abort), the executor must not
// write extracted/<id>.json or transcripts/<id>.json any more.
describe('PDFExtractionExecutor — abort before writing', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pdf-abort-test-'))
    state.pdfPath = join(dir, 's1.pdf')
    state.metadataPending = false
    writeFileSync(state.pdfPath, '%PDF-1.4')
    mockWriteFileAtomic.mockClear()
    mockBuildTranscript.mockClear()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('settles on abort while getMetadata hangs and writes nothing', async () => {
    const controller = new AbortController()
    const task = { id: 't1', sessionId: 's1', type: 'extraction' } as Task
    const run = new PDFExtractionExecutor().execute(task, () => {}, controller.signal)

    for (let i = 0; i < 50 && !state.metadataPending; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(state.metadataPending).toBe(true)
    controller.abort()

    await expect(run).rejects.toThrow('Verarbeitung abgebrochen')
    expect(mockWriteFileAtomic).not.toHaveBeenCalled()
    expect(mockBuildTranscript).not.toHaveBeenCalled()
  })
})
