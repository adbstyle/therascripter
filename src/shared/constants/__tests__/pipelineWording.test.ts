import { describe, it, expect } from 'vitest'
import { STEP_LABELS_DE, PIPELINE_UI_STRINGS, formatEta } from '../pipelineWording'
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

  it('formatEta returns null for null input', () => {
    expect(formatEta(null)).toBeNull()
  })

  it('formatEta returns "Fast fertig" for ETA < 30s', () => {
    expect(formatEta(0)).toBe('Fast fertig')
    expect(formatEta(15)).toBe('Fast fertig')
    expect(formatEta(29)).toBe('Fast fertig')
  })

  it('formatEta returns "noch ca. 1 Min." for ETA 30-60s', () => {
    expect(formatEta(30)).toBe('noch ca. 1 Min.')
    expect(formatEta(45)).toBe('noch ca. 1 Min.')
    expect(formatEta(59)).toBe('noch ca. 1 Min.')
  })

  it('formatEta returns "noch ca. N Min." for ETA ≥ 60s, rounded', () => {
    expect(formatEta(60)).toBe('noch ca. 1 Min.')
    expect(formatEta(150)).toBe('noch ca. 3 Min.') // 150/60 = 2.5, rounds to 3
    expect(formatEta(180)).toBe('noch ca. 3 Min.')
    expect(formatEta(3600)).toBe('noch ca. 60 Min.')
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
