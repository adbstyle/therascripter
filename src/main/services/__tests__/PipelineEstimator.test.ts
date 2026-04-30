import { describe, it, expect, beforeEach } from 'vitest'
import { PipelineEstimator } from '../PipelineEstimator'
import { PipelineStatsService } from '../PipelineStatsService'
import type { AppSettings } from '../SettingsService'

function makeStubStore(): Pick<
  import('electron-store').default<AppSettings>,
  'get' | 'set'
> {
  const state: Record<string, unknown> = {}
  return {
    get: ((key: string) => state[key]) as unknown as Pick<
      import('electron-store').default<AppSettings>,
      'get'
    >['get'],
    set: ((key: string, value: unknown) => {
      state[key] = value
    }) as unknown as Pick<
      import('electron-store').default<AppSettings>,
      'set'
    >['set']
  }
}

describe('PipelineEstimator', () => {
  let stats: PipelineStatsService
  let est: PipelineEstimator

  beforeEach(() => {
    stats = new PipelineStatsService(makeStubStore())
    est = new PipelineEstimator(stats)
  })

  it('uses baked-in default when fewer than 3 samples', () => {
    // 60 min audio (3600s) × 0.20 baked-in transcription rate = 720s
    expect(est.estimate('transcription', { audioSec: 3600 })).toBe(720)
  })

  it('switches to median-of-recent once 3+ samples exist', () => {
    stats.recordRate('transcription', 600, 60) // 0.10 per sec
    stats.recordRate('transcription', 600, 120) // 0.20 per sec
    stats.recordRate('transcription', 600, 90) // 0.15 per sec
    // median of [0.10, 0.15, 0.20] = 0.15; for 3600s = 540s
    expect(est.estimate('transcription', { audioSec: 3600 })).toBeCloseTo(540, 0)
  })

  it('returns null totalEta when not calibrated', () => {
    expect(
      est.totalEta(['transcription', 'anonymization'], 'transcription', 0.5, { audioSec: 600 })
    ).toBeNull()
  })

  it('returns positive totalEta when calibrated and progress < 1', () => {
    for (let i = 0; i < 3; i++) {
      stats.recordRate('transcription', 600, 100)
      stats.recordWords('anonymization', 500, 8)
    }
    const eta = est.totalEta(['transcription', 'anonymization'], 'transcription', 0.5, {
      audioSec: 600,
      wordCount: 500
    })
    expect(eta).not.toBeNull()
    // Half of transcription remains (50s), then anonymization (~8s) → ~58s
    expect(eta!).toBeGreaterThan(40)
    expect(eta!).toBeLessThan(120)
  })

  it('handles wordCount-domain steps without audio', () => {
    // anonymization baked-in: fixed 8 + 0.001 × words
    expect(est.estimate('anonymization', { wordCount: 1000 })).toBeCloseTo(9, 1)
  })

  it('handles page-domain steps for pdf', () => {
    // extraction baked-in: fixed 1 + 0.3 × pages = 1 + 3 = 4s for 10 pages
    expect(est.estimate('extraction', { pages: 10 })).toBeCloseTo(4, 1)
  })

  it('isCalibrated() turns true once transcription has 3+ samples', () => {
    expect(est.isCalibrated()).toBe(false)
    for (let i = 0; i < 3; i++) stats.recordRate('transcription', 600, 100)
    expect(est.isCalibrated()).toBe(true)
  })

  it('isCalibrated() turns true once extraction has 3+ samples (pdf-only users)', () => {
    expect(est.isCalibrated()).toBe(false)
    for (let i = 0; i < 3; i++) stats.recordPages('extraction', 5, 2)
    expect(est.isCalibrated()).toBe(true)
  })

  it('totalEta returns null when currentStep is not in plannedSteps', () => {
    for (let i = 0; i < 3; i++) stats.recordRate('transcription', 600, 100)
    const eta = est.totalEta(['transcription'], 'anonymization', 0.5, {
      audioSec: 600,
      wordCount: 500
    })
    expect(eta).toBeNull()
  })

  it('totalEta returns 0 when current step is at progress 1 and no future steps', () => {
    for (let i = 0; i < 3; i++) stats.recordRate('transcription', 600, 100)
    const eta = est.totalEta(['transcription'], 'transcription', 1, { audioSec: 600 })
    expect(eta).toBe(0)
  })
})
