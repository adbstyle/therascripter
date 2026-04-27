import type { EntityMap } from './EntityMap'

export type SessionType = 'audio' | 'pdf'

export type SessionStatus =
  | 'recording'
  | 'transcribing'
  | 'diarizing'
  | 'extracting'
  | 'anonymizing'
  | 'review'
  | 'transcription_quality_failed'
  | 'error'

export type QualityFlag = 'repetition_warning'

export interface Session {
  id: string
  title: string
  type: SessionType
  status: SessionStatus
  audioPath: string | null
  transcriptPath: string | null
  anonymizedPath: string | null
  diarizationPath: string | null
  alignedTranscriptPath: string | null
  pdfPath: string | null
  extractedPath: string | null
  entityMap: EntityMap | null
  errorMessage: string | null
  createdAt: string
  updatedAt: string
  reviewAt: string | null
  wordCount: number | null
  summary: string | null
  summaryModelId: string | null
  summarizedAt: string | null
  qualityFlag: QualityFlag | null
  transcriptionPipelineVersion: number | null
}

export interface CreateSessionInput {
  title: string
  type: SessionType
  status?: SessionStatus
  audioPath?: string
  pdfPath?: string
}

export interface UpdateSessionInput {
  title?: string
  status?: SessionStatus
  audioPath?: string | null
  transcriptPath?: string | null
  anonymizedPath?: string | null
  diarizationPath?: string | null
  alignedTranscriptPath?: string | null
  pdfPath?: string | null
  extractedPath?: string | null
  entityMap?: EntityMap | null
  errorMessage?: string | null
  reviewAt?: string | null
  wordCount?: number | null
  summary?: string | null
  summaryModelId?: string | null
  summarizedAt?: string | null
  qualityFlag?: QualityFlag | null
  transcriptionPipelineVersion?: number | null
}
