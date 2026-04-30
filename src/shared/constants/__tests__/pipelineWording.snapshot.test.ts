import { describe, it, expect } from 'vitest'
import { STEP_LABELS_DE, PIPELINE_UI_STRINGS } from '../pipelineWording'

/**
 * Issue #80 Phase N — final wording lock.
 *
 * This snapshot test pins the agreed German glossary so accidental changes
 * (e.g. via copy-paste, AI edits, or a misguided "polish" pass) trip CI.
 * Update only after explicit PO + UX sign-off.
 */
describe('pipelineWording snapshot — Issue #80 Story 9 / AC#2 final lock', () => {
  it('STEP_LABELS_DE matches the agreed glossary', () => {
    expect(STEP_LABELS_DE).toEqual({
      diarization: 'Sprecher unterscheiden',
      transcription: 'Gespräch transkribieren',
      alignment: 'Audio aufbereiten',
      anonymization: 'Persönliche Angaben anonymisieren',
      summarization: 'Zusammenfassung erstellen',
      extraction: 'Text auslesen',
      ocr: 'Schrift erkennen'
    })
  })

  it('PIPELINE_UI_STRINGS literal strings are locked', () => {
    expect(PIPELINE_UI_STRINGS.preparingNext).toBe('Nächster Schritt wird vorbereitet…')
    expect(PIPELINE_UI_STRINGS.emptySpeechHeadline).toBe('Keine Sprache erkannt')
    expect(PIPELINE_UI_STRINGS.emptySpeechBody).toBe(
      'Sitzung wurde abgeschlossen, ohne dass Sprache erkannt wurde.'
    )
    expect(PIPELINE_UI_STRINGS.watchdogHeadline).toBe('Verarbeitung unterbrochen')
    expect(PIPELINE_UI_STRINGS.watchdogBody).toBe(
      'Die Verarbeitung wurde nach längerer Inaktivität abgebrochen.'
    )
    expect(PIPELINE_UI_STRINGS.retryButton).toBe('Erneut versuchen')
    expect(PIPELINE_UI_STRINGS.retryAfterFirstFailure).toBe('Erster Versuch ist fehlgeschlagen.')
    expect(PIPELINE_UI_STRINGS.retryAfterSecondFailure).toBe(
      'Mehrfach-Fehler — bitte App neu starten oder Logs prüfen.'
    )
    expect(PIPELINE_UI_STRINGS.retryExhausted).toBe(
      'Verarbeitung schlägt wiederholt fehl. Wenden Sie sich an den Support.'
    )
  })

  it('PIPELINE_UI_STRINGS function outputs match the agreed format', () => {
    expect(PIPELINE_UI_STRINGS.waiting(1)).toBe('Wartet — Position 1')
    expect(PIPELINE_UI_STRINGS.waiting(99)).toBe('Wartet — Position 99')
    expect(PIPELINE_UI_STRINGS.step(1, 5, 'X')).toBe('Schritt 1/5 · X')
  })

  it('contains zero ML-jargon anywhere', () => {
    const all = [
      ...Object.values(STEP_LABELS_DE),
      ...Object.values(PIPELINE_UI_STRINGS).filter((v) => typeof v === 'string')
    ]
      .join(' ')
      .toLowerCase()
    const forbidden = [
      'diarisierung',
      'alignment',
      'ner',
      'whisper',
      'pyannote',
      'transformer',
      'flair',
      'llm',
      'ocr', // user-facing strings should never call it OCR
      'tokenizer'
    ]
    for (const word of forbidden) {
      expect(all).not.toContain(word)
    }
  })

  it('uses Sie-form throughout (no du/dein/dir)', () => {
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
