import { describe, it, expect } from 'vitest'
import { STEP_LABELS_DE, PIPELINE_UI_STRINGS } from '../pipelineWording'
import type { TaskType } from '../../types'

describe('pipelineWording', () => {
  it('covers every TaskType', () => {
    const taskTypes: TaskType[] = [
      'diarization',
      'transcription',
      'alignment',
      'anonymization',
      'summarization',
      'extraction',
      'ocr'
    ]
    for (const t of taskTypes) {
      expect(STEP_LABELS_DE[t]).toBeTruthy()
      expect(STEP_LABELS_DE[t].length).toBeGreaterThan(0)
    }
  })

  it('contains no ML jargon (Diarisierung, Alignment, NER, OCR-Fachbegriff)', () => {
    const all = Object.values(STEP_LABELS_DE).join(' ').toLowerCase()
    expect(all).not.toContain('diarisierung')
    expect(all).not.toContain('alignment')
    expect(all).not.toContain('ner')
    expect(all).not.toContain('whisper')
    expect(all).not.toContain('pyannote')
  })

  it('produces correct waiting label', () => {
    expect(PIPELINE_UI_STRINGS.waiting(2)).toBe('Wartet — Position 2')
  })

  it('produces correct step label with counter', () => {
    expect(PIPELINE_UI_STRINGS.step(3, 5, 'Gespräch transkribieren')).toBe(
      'Schritt 3/5 · Gespräch transkribieren'
    )
  })

  it('uses Sie-form throughout (no "du"/"dein")', () => {
    const all = [
      ...Object.values(STEP_LABELS_DE),
      ...Object.values(PIPELINE_UI_STRINGS).filter((v) => typeof v === 'string')
    ]
      .join(' ')
      .toLowerCase()
    expect(all).not.toMatch(/\bdu\b/)
    expect(all).not.toMatch(/\bdein/)
    expect(all).not.toMatch(/\bdir\b/)
  })
})
