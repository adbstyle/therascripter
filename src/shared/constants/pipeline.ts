import type { TaskType } from '../types'

// Single source of truth für Audio-Pipeline-Reihenfolge.
// Wird von Backend (TaskQueueService) und Frontend (SessionCard) importiert,
// damit Drift strukturell unmöglich ist — Issue #78 / NFR-2 (Single Source of Truth).
//
// Reihenfolge nach ADR-007: Pyannote diarization runs before whisper-cli so the
// ASR receives only speech audio (silence-induced hallucinations are structurally
// prevented).
export const AUDIO_PIPELINE: readonly TaskType[] = [
  'diarization',
  'transcription',
  'alignment',
  'anonymization',
  'summarization'
] as const

export const PDF_PIPELINE: readonly TaskType[] = [
  'extraction',
  'ocr',
  'anonymization',
  'summarization'
] as const
