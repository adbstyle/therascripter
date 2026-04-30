import { describe, it, expect, beforeEach } from 'vitest'
import { PipelineStatsService } from '../PipelineStatsService'
import type { AppSettings, PipelineStats } from '../SettingsService'

function makeStubStore(): Pick<
  import('electron-store').default<AppSettings>,
  'get' | 'set'
> & {
  state: Partial<AppSettings>
} {
  const state: Partial<AppSettings> = {}
  return {
    state,
    get: ((key: string) => {
      return (state as Record<string, unknown>)[key]
    }) as unknown as Pick<
      import('electron-store').default<AppSettings>,
      'get'
    >['get'],
    set: ((key: string, value: unknown) => {
      ;(state as Record<string, unknown>)[key] = value
    }) as unknown as Pick<
      import('electron-store').default<AppSettings>,
      'set'
    >['set']
  }
}

describe('PipelineStatsService', () => {
  let store: ReturnType<typeof makeStubStore>
  let svc: PipelineStatsService

  beforeEach(() => {
    store = makeStubStore()
    svc = new PipelineStatsService(store)
  })

  it('returns empty stats when no data is stored', () => {
    const stats = svc.getAll()
    expect(stats.transcription).toEqual([])
    expect(stats.diarization).toEqual([])
  })

  it('keeps only last 5 samples per step', () => {
    for (let i = 0; i < 7; i++) {
      svc.recordRate('transcription', 600, 100 + i)
    }
    expect(svc.getAll().transcription).toHaveLength(5)
  })

  it('preserves chronological order (oldest first, newest last)', () => {
    svc.recordRate('transcription', 600, 100)
    svc.recordRate('transcription', 600, 200)
    svc.recordRate('transcription', 600, 300)
    const samples = svc.getAll().transcription
    expect(samples[0].durationSec).toBe(100)
    expect(samples[2].durationSec).toBe(300)
  })

  it('persists samples across PipelineStatsService instances', () => {
    svc.recordRate('diarization', 600, 30)
    const fresh = new PipelineStatsService(store)
    expect(fresh.getAll().diarization).toHaveLength(1)
  })

  it('routes wordCount samples to the right step', () => {
    svc.recordWords('anonymization', 500, 8)
    svc.recordWords('summarization', 500, 12)
    expect(svc.getAll().anonymization).toHaveLength(1)
    expect(svc.getAll().summarization).toHaveLength(1)
  })

  it('routes page samples to the right step', () => {
    svc.recordPages('extraction', 10, 3)
    svc.recordPages('ocr', 10, 15)
    expect(svc.getAll().extraction).toHaveLength(1)
    expect(svc.getAll().ocr).toHaveLength(1)
  })

  it('tolerates partially-populated legacy state (missing keys)', () => {
    // Simulate a settings file from before pipelineStats was introduced
    const partial = { transcription: [{ audioSec: 600, durationSec: 100, ts: 1 }] } as unknown as PipelineStats
    store.state.pipelineStats = partial
    const stats = svc.getAll()
    expect(stats.transcription).toHaveLength(1)
    expect(stats.diarization).toEqual([])
  })
})
