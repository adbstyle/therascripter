import type { EntityMap } from './EntityMap'
import type { TaskType } from './Task'
import type { ProcessedModelsSnapshot } from './Provenance'

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
  /**
   * Issue #80 Phase G — set by the PDF importer's heuristic (extract first 3
   * pages of text; <50 chars total → likely scanned, needs OCR). NULL for
   * audio sessions and legacy PDF rows.
   */
  pdfHasScannedPages: boolean | null
  /**
   * Issue #84 Story I — captured-at-source snapshot of the active models per
   * pipeline group, written by TaskQueueService when the pipeline starts.
   * NULL for legacy rows that reached 'review' before this column existed.
   */
  processedWithModels: ProcessedModelsSnapshot | null
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
  pdfHasScannedPages?: boolean | null
  processedWithModels?: ProcessedModelsSnapshot | null
}
