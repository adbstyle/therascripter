import type { Session, SessionType } from './Session'
import type { Task, TaskType } from './Task'
import type { BlocklistEntry } from './NerTypes'
import type { EntityMap, PlaceholderType } from './EntityMap'
import type { TipTapDocument } from './TipTapDocument'
import type { PendingModelUpdate, AppUpdateStatus, CheckResult } from './ModelUpdate'
import type { ReconcileEvent } from './ReconcileEvent'
import type { ProcessedModelsSnapshot, AudioStats } from './Provenance'
import type {
  ModelCatalogEntry,
  ModelGroup,
  DiarizationPipeline
} from '../validation/model-catalog-schemas'

export interface SessionApi {
  list(): Promise<Session[]>
  delete(sessionId: string): Promise<boolean>
  rename(sessionId: string, title: string): Promise<Session | null>
}

export interface RecordingApi {
  start(): Promise<{ sessionId: string }>
  stop(sessionId: string): Promise<{ durationSeconds: number }>
  sendData(sessionId: string, samples: ArrayBuffer): void
  onDuration(callback: (data: { seconds: number }) => void): () => void
  onError(callback: (data: { message: string }) => void): () => void
  onAutoStopped(callback: () => void): () => void
}

export interface SettingsApi {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}

export interface TaskProgressData {
  sessionId: string
  taskType: TaskType
  progress: number
}

export interface TaskStartedData {
  sessionId: string
  taskType: TaskType
  /** 1-based position in plannedSteps; 0 if task not in plannedSteps */
  stepIndex: number
  /** Length of plannedSteps; 0 if no plan was frozen */
  totalSteps: number
}

export interface TaskCompletedData {
  sessionId: string
  taskType: TaskType
}

export interface TaskErrorData {
  sessionId: string
  taskType: TaskType
  error: string
}

export interface QueuePositionsData {
  /** Map sessionId → 1-based position in queue. Sessions not queued are absent. */
  positions: Record<string, number>
}

export interface TasksApi {
  getSessionTasks(sessionId: string): Promise<Task[]>
  isProcessing(): Promise<boolean>
  retry(sessionId: string): Promise<void>
  onProgress(callback: (data: TaskProgressData) => void): () => void
  onStarted(callback: (data: TaskStartedData) => void): () => void
  onCompleted(callback: (data: TaskCompletedData) => void): () => void
  onError(callback: (data: TaskErrorData) => void): () => void
  onQueuePositions(callback: (data: QueuePositionsData) => void): () => void
}

export interface BlocklistApi {
  list(): Promise<BlocklistEntry[]>
  add(term: string, placeholderType: PlaceholderType): Promise<BlocklistEntry>
  update(id: string, term: string, placeholderType: PlaceholderType): Promise<BlocklistEntry | null>
  delete(id: string): Promise<boolean>
}

export interface ImportApi {
  pdf(filePaths: string[]): Promise<Session[]>
  showPDFDialog(): Promise<string[]>
  getPathForFile(file: File): string
}

export interface ReviewData {
  document: TipTapDocument
  entityMap: EntityMap
  sessionType: SessionType
  sessionTitle: string
  /**
   * Issue #84 Story I — captured at pipeline-start. NULL for sessions that
   * reached 'review' before this column was introduced; the renderer surfaces
   * the legacy hint in that case.
   */
  processedWithModels: ProcessedModelsSnapshot | null
  /**
   * Issue #84 Story I — when the session transitioned to 'review' (≈ when the
   * pipeline finished). Used as "Verarbeitet am" in the provenance panel.
   * NULL only if the row pre-dates Migration 003 which is unlikely in
   * practice; the panel falls back to omitting the timestamp.
   */
  reviewAt: string | null
  /**
   * Issue #99 — aggregated from `transcript.metadata.stitchMap` and the
   * diarization JSON. NULL for PDF sessions and for any audio session whose
   * data sources are completely unreadable.
   */
  audioStats: AudioStats | null
}

export interface ReviewApi {
  load(sessionId: string): Promise<ReviewData>
  save(sessionId: string, document: TipTapDocument, entityMap: EntityMap): Promise<void>
  exportClipboard(text: string): Promise<void>
}

export interface AboutInfo {
  version: string
  electronVersion: string
  osVersion: string
  chip: string
  totalMemoryGB: number
  fileVaultActive: boolean | null
  storageModelsBytes: number
  storageSessionsBytes: number
  dataDir: string
}

export interface SystemApi {
  aboutInfo(): Promise<AboutInfo>
  uninstall(): Promise<boolean>
  openInFinder(path: string): Promise<void>
}

export interface ModelDownloadProgress {
  currentModel: string
  currentModelLabel: string
  currentModelProgress: number
  currentModelDownloaded: number
  currentModelTotal: number
  overallDownloaded: number
  overallTotal: number
  overallPercent: number
}

export type ModelDownloadStatus =
  | { state: 'idle' }
  | { state: 'downloading'; progress: ModelDownloadProgress }
  | { state: 'extracting'; modelId: string }
  | { state: 'verifying'; modelId: string }
  | { state: 'complete' }
  | { state: 'error'; error: string; modelId: string }

export interface ModelStatusInfo {
  modelsReady: boolean
  models: Array<{ id: string; label: string; sizeBytes: number }>
}

export interface DiskSpaceInfo {
  sufficient: boolean
  availableBytes: number
  requiredBytes: number
}

export interface ModelDownloadApi {
  status(): Promise<ModelStatusInfo>
  checkDiskSpace(): Promise<DiskSpaceInfo>
  start(): Promise<void>
  onStatus(callback: (status: ModelDownloadStatus) => void): () => void
}

export interface ModelUpdateRestartResult {
  allowed: boolean
  reason?: 'recording' | 'processing'
}

export interface ModelUpdateApi {
  check(): Promise<PendingModelUpdate[]>
  restart(updates: PendingModelUpdate[]): Promise<ModelUpdateRestartResult>
  startDownload(): Promise<void>
  getPending(): Promise<PendingModelUpdate[] | null>
  clearPending(): Promise<void>
  /**
   * Issue #84 / Story F+G — record that the user actively dismissed these
   * manifest entries. Future update checks filter them out until the manifest
   * publishes a new sha256 for the same id.
   */
  dismissVersions(updates: PendingModelUpdate[]): Promise<void>
  onAvailable(callback: (updates: PendingModelUpdate[]) => void): () => void
  onDownloadProgress(callback: (status: ModelDownloadStatus) => void): () => void
  onDownloadComplete(callback: () => void): () => void
  onDownloadError(callback: (error: string) => void): () => void
}

export interface AppUpdateApi {
  getStatus(): Promise<AppUpdateStatus>
  check(): Promise<CheckResult>
  openReleasePage(): Promise<void>
  onStatus(callback: (status: AppUpdateStatus) => void): () => void
}

export interface SummaryRecord {
  title: string | null
  text: string
  modelId: string | null
  summarizedAt: string | null
}

export interface SummaryApi {
  get(sessionId: string): Promise<SummaryRecord | null>
  updateTitle(sessionId: string, title: string): Promise<void>
  updateText(sessionId: string, text: string): Promise<void>
}

export interface NavApi {
  onOpenSettings(callback: () => void): () => void
}

export interface ModelCatalogApi {
  list(group: ModelGroup): Promise<ModelCatalogEntry[]>
  listAsr(): Promise<ModelCatalogEntry[]>
  download(id: string): Promise<ModelCatalogEntry[]>
  delete(id: string): Promise<ModelCatalogEntry[]>
  setActive(group: ModelGroup, id: string): Promise<ModelCatalogEntry[]>
  clearActive(group: ModelGroup): Promise<ModelCatalogEntry[]>
  cancelDownload(): Promise<void>
}

export interface PipelineApi {
  getDiarization(): Promise<DiarizationPipeline>
  setDiarization(pipeline: DiarizationPipeline): Promise<DiarizationPipeline>
  listDiarization(): Promise<readonly DiarizationPipeline[]>
}

export interface ModelReconcileApi {
  /** Read all reconcile events (pending + seen). */
  getEvents(): Promise<ReconcileEvent[]>
  /** Mark every pending event as seen — call when Settings → Modelle mounts. */
  markSeen(): Promise<ReconcileEvent[]>
  /** Permanently dismiss all reconcile events — call from the "Verstanden" button. */
  dismiss(): Promise<void>
}

export interface IpcApi {
  sessions: SessionApi
  recording: RecordingApi
  settings: SettingsApi
  tasks: TasksApi
  blocklist: BlocklistApi
  import: ImportApi
  review: ReviewApi
  system: SystemApi
  modelDownload: ModelDownloadApi
  modelCatalog: ModelCatalogApi
  modelUpdate: ModelUpdateApi
  modelReconcile: ModelReconcileApi
  pipeline: PipelineApi
  appUpdate: AppUpdateApi
  summary: SummaryApi
  nav: NavApi
}
