import type { TaskType } from '../../shared/types'
import type { PipelineStatsService } from './PipelineStatsService'

const MIN_SAMPLES_FOR_OVERRIDE = 3

/**
 * Aggregate of all dimensions the estimator needs. Caller passes whatever
 * is known about the session; per-step routing happens internally.
 */
export interface SessionMeta {
  audioSec?: number
  wordCount?: number
  pages?: number
}

/**
 * Issue #80 Phase I — baked-in defaults pre-calibration.
 * These match observed magnitudes on M-series Macs but are intentionally
 * generic; the user-specific median takes over after 3 sessions.
 */
const BAKED_IN_DEFAULTS = {
  diarization: { kind: 'rate' as const, rate: 0.05 },
  transcription: { kind: 'rate' as const, rate: 0.2 },
  alignment: { kind: 'rate' as const, rate: 0.005 },
  anonymization: { kind: 'words' as const, fixed: 8, perUnit: 0.001 },
  summarization: { kind: 'words' as const, fixed: 12, perUnit: 0.002 },
  extraction: { kind: 'pages' as const, fixed: 1, perUnit: 0.3 },
  ocr: { kind: 'pages' as const, fixed: 2, perUnit: 1.5 }
}

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/**
 * Issue #80 Phase I — predicts ETA per step + total session.
 *
 * Architecture (from plan §I):
 * - estimate(step, meta) returns a positive duration in seconds, falling back
 *   to baked-in defaults until MIN_SAMPLES_FOR_OVERRIDE samples exist
 * - isCalibrated() reports true once telemetry has been gathered
 * - totalEta() returns null when uncalibrated so the UI can hide the ETA;
 *   this is the signal SessionCard uses to gate the Phase J total bar
 */
export class PipelineEstimator {
  constructor(private stats: PipelineStatsService) {}

  estimate(step: TaskType, meta: SessionMeta): number {
    const all = this.stats.getAll()
    const def = BAKED_IN_DEFAULTS[step]

    if (def.kind === 'rate') {
      const audioSec = meta.audioSec ?? 0
      const samples = all[step] as { audioSec: number; durationSec: number }[]
      if (samples.length >= MIN_SAMPLES_FOR_OVERRIDE) {
        const rates = samples.map((s) => s.durationSec / Math.max(s.audioSec, 1))
        return median(rates) * audioSec
      }
      return def.rate * audioSec
    }
    if (def.kind === 'words') {
      const wc = meta.wordCount ?? 0
      const samples = all[step] as { wordCount: number; durationSec: number }[]
      if (samples.length >= MIN_SAMPLES_FOR_OVERRIDE) {
        return median(samples.map((s) => s.durationSec))
      }
      return def.fixed + def.perUnit * wc
    }
    // pages
    const p = meta.pages ?? 0
    const samples = all[step] as { pages: number; durationSec: number }[]
    if (samples.length >= MIN_SAMPLES_FOR_OVERRIDE) {
      const rates = samples.map((s) => s.durationSec / Math.max(s.pages, 1))
      return median(rates) * p
    }
    return def.fixed + def.perUnit * p
  }

  /**
   * True once the user has run enough sessions to enable real ETA. Uses
   * transcription samples as the canonical "audio session ran" signal, plus
   * extraction for PDF-only users.
   */
  isCalibrated(): boolean {
    const all = this.stats.getAll()
    return (
      all.transcription.length >= MIN_SAMPLES_FOR_OVERRIDE ||
      all.extraction.length >= MIN_SAMPLES_FOR_OVERRIDE
    )
  }

  /**
   * Total ETA across remaining steps for a session at given progress within
   * the current step. Returns null when uncalibrated — UI uses this signal
   * to hide the ETA display before enough telemetry is gathered.
   */
  totalEta(
    plannedSteps: TaskType[],
    currentStep: TaskType,
    currentProgress: number,
    meta: SessionMeta
  ): number | null {
    if (!this.isCalibrated()) return null
    const idx = plannedSteps.indexOf(currentStep)
    if (idx < 0) return null

    let total = this.estimate(currentStep, meta) * (1 - currentProgress)
    for (const step of plannedSteps.slice(idx + 1)) {
      total += this.estimate(step, meta)
    }
    return Math.max(0, total)
  }
}
