import type { EntityMap } from './EntityMap'
import type { TaskType } from './Task'

export type SessionType = 'audio' | 'pdf'

export type SessionStatus =
  | 'recording'
  | 'queued'
  | 'processing'
  | 'review'
  | 'error'

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
  plannedSteps: TaskType[] | null
  retryCount: number
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
  plannedSteps?: TaskType[] | null
  retryCount?: number
}
