import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { AUDIO_PIPELINE, PDF_PIPELINE } from '../constants/pipeline'

// __dirname → src/shared/__tests__; repo root is 3 levels up
const ROOT = join(__dirname, '..', '..', '..')

describe('Pipeline order (single source of truth)', () => {
  it('AUDIO_PIPELINE has diarization before transcription (post-inversion, ADR-007)', () => {
    const dIdx = AUDIO_PIPELINE.indexOf('diarization')
    const tIdx = AUDIO_PIPELINE.indexOf('transcription')
    expect(dIdx).toBeGreaterThanOrEqual(0)
    expect(tIdx).toBeGreaterThan(dIdx)
  })

  it('AUDIO_PIPELINE ends with summarization (graceful-skip tail step)', () => {
    expect(AUDIO_PIPELINE[AUDIO_PIPELINE.length - 1]).toBe('summarization')
  })

  it('AUDIO_PIPELINE matches expected post-inversion order exactly', () => {
    expect([...AUDIO_PIPELINE]).toEqual([
      'diarization',
      'transcription',
      'alignment',
      'anonymization',
      'summarization'
    ])
  })

  it('PDF_PIPELINE is unchanged (extraction → ocr → anonymization → summarization)', () => {
    expect([...PDF_PIPELINE]).toEqual([
      'extraction',
      'ocr',
      'anonymization',
      'summarization'
    ])
  })
})

describe('Pipeline-order single-source-of-truth assertions', () => {
  it('TaskQueueService imports from shared/constants/pipeline (no local duplicate)', () => {
    const src = readFileSync(
      join(ROOT, 'src/main/services/TaskQueueService.ts'),
      'utf-8'
    )
    expect(src).toContain("from '../../shared/constants/pipeline'")
    expect(src).not.toMatch(/^const AUDIO_PIPELINE\s*:/m)
  })

  it('SessionCard imports from shared/constants/pipeline (no local duplicate)', () => {
    const src = readFileSync(
      join(ROOT, 'src/renderer/src/components/SessionCard.tsx'),
      'utf-8'
    )
    expect(src).toContain("from '../../../shared/constants/pipeline'")
    expect(src).not.toMatch(/^const AUDIO_PIPELINE_STEPS\s*[:=]/m)
  })
})
