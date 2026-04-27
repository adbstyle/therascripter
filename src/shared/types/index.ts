export type ThemePreference = 'light' | 'system' | 'dark'

export type { PlaceholderType, EntitySource, EntityMapEntry, EntityMap } from './EntityMap'

export type {
  SessionType,
  SessionStatus,
  Session,
  CreateSessionInput,
  UpdateSessionInput,
  QualityFlag
} from './Session'

export type { TaskType, TaskStatus, Task, CreateTaskInput, UpdateTaskInput } from './Task'

export type {
  SessionApi,
  RecordingApi,
  SettingsApi,
  TasksApi,
  BlocklistApi,
  TaskProgressData,
  TaskCompletedData,
  TaskErrorData,
  ImportApi,
  ReviewApi,
  ReviewData,
  AboutInfo,
  SystemApi,
  ModelDownloadProgress,
  ModelDownloadStatus,
  ModelStatusInfo,
  DiskSpaceInfo,
  ModelDownloadApi,
  ModelCatalogApi,
  ModelUpdateRestartResult,
  ModelUpdateApi,
  AppUpdateApi,
  IpcApi
} from './IpcApi'

export type {
  TranscriptWord,
  TranscriptSegment,
  TranscriptMetadata,
  TranscriptData
} from './Transcript'

export type { SpeakerSegment, DiarizationMetadata, DiarizationData } from './Diarization'

export type {
  NerEntity,
  RegexEntity,
  MergedEntity,
  NerServiceOutput,
  BlocklistEntry
} from './NerTypes'

export type {
  TipTapDocument,
  TipTapParagraph,
  TipTapInlineNode,
  TipTapTextNode,
  TipTapPlaceholderChip,
  TipTapPlaceholderChipAttrs,
  TipTapSpeakerLabel,
  TipTapSpeakerLabelAttrs,
  TipTapTimestamp,
  TipTapTimestampAttrs
} from './TipTapDocument'

export type { PageData, ExtractionResult } from './PDFTypes'

export type {
  ManifestModel,
  Manifest,
  PendingModelUpdate,
  InstalledModelVersion,
  AppUpdateStatus,
  CheckResult
} from './ModelUpdate'
