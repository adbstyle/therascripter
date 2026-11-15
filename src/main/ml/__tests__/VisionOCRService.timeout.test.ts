import { describe, it, expect, vi, beforeEach } from 'vitest'

const runSubprocess = vi.fn()
vi.mock('../../utils/subprocess', () => ({
  runSubprocess: (...args: unknown[]) => runSubprocess(...args)
}))
vi.mock('../../services/ToolHealthService', () => ({
  throwIfToolBlocked: vi.fn()
}))

import { VisionOCRService } from '../VisionOCRService'
import { OCR_PAGE_TIMEOUT_MS } from '../ocr-limits'

type OcrPage = (bin: string, pdf: string, page: number, signal?: AbortSignal) => Promise<string>

function ocrPage(): OcrPage {
  const service = new VisionOCRService() as unknown as { ocrPage: OcrPage }
  return service.ocrPage.bind(service)
}

describe('VisionOCRService page timeout', () => {
  beforeEach(() => runSubprocess.mockReset())

  // Kaltstart von Apple Vision auf macOS 27: 25–35 s für die erste Seite.
  it('gives each page a timeout well above the Vision cold start', async () => {
    runSubprocess.mockResolvedValue({
      code: 0,
      timedOut: false,
      aborted: false,
      stdout: JSON.stringify({ text: 'Seite', confidence: 1, language: 'de', pageNumber: 2 }),
      stderr: ''
    })

    await ocrPage()('/bin/vision-ocr', '/tmp/x.pdf', 2)

    expect(OCR_PAGE_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000)
    expect(runSubprocess).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: OCR_PAGE_TIMEOUT_MS })
    )
  })

  it('reports a page timeout in German with the actual limit and without paths', async () => {
    runSubprocess.mockResolvedValue({
      code: null,
      timedOut: true,
      aborted: false,
      stdout: '',
      stderr: ''
    })

    const error = await ocrPage()('/bin/vision-ocr', '/geheim/patient.pdf', 2).catch((e) => e)

    expect(error.message).toBe('OCR für Seite 2 abgebrochen: Timeout nach 120s')
    expect(error.message).not.toContain('/')
  })
})
