import type Store from 'electron-store'
import type { AppSettings, PipelineStats } from './SettingsService'

const MAX_SAMPLES_PER_STEP = 5

const EMPTY_STATS: PipelineStats = {
  diarization: [],
  transcription: [],
  alignment: [],
  anonymization: [],
  summarization: [],
  extraction: [],
  ocr: []
}

/**
 * Issue #80 Phase I — read/write pipeline-step duration telemetry.
 *
 * The store is electron-store, so each method does a get-mutate-set cycle.
 * That's safe because TaskQueueService runs sequentially: only one
 * recordRate/recordWords/recordPages is in-flight at a time.
 *
 * Tests can pass a custom store-like object to inject in-memory state.
 */
export class PipelineStatsService {
  constructor(private store: Pick<Store<AppSettings>, 'get' | 'set'>) {}

  getAll(): PipelineStats {
    const stored = this.store.get('pipelineStats')
    if (!stored) return EMPTY_STATS
    // Defensive: settings file from older app version may have missing keys.
    return {
      ...EMPTY_STATS,
      ...stored
    }
  }

  recordRate(
    step: 'diarization' | 'transcription' | 'alignment',
    audioSec: number,
    durationSec: number
  ): void {
    const all = this.getAll()
    const samples = [...all[step], { audioSec, durationSec, ts: Date.now() }].slice(
      -MAX_SAMPLES_PER_STEP
    )
    this.store.set('pipelineStats', { ...all, [step]: samples })
  }

  recordWords(
    step: 'anonymization' | 'summarization',
    wordCount: number,
    durationSec: number
  ): void {
    const all = this.getAll()
    const samples = [...all[step], { wordCount, durationSec, ts: Date.now() }].slice(
      -MAX_SAMPLES_PER_STEP
    )
    this.store.set('pipelineStats', { ...all, [step]: samples })
  }

  recordPages(step: 'extraction' | 'ocr', pages: number, durationSec: number): void {
    const all = this.getAll()
    const samples = [...all[step], { pages, durationSec, ts: Date.now() }].slice(
      -MAX_SAMPLES_PER_STEP
    )
    this.store.set('pipelineStats', { ...all, [step]: samples })
  }
}
