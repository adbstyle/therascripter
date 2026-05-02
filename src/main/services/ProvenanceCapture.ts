import { getActiveModelId, getModelById } from './ModelDownloadService'
import { getSettings } from './SettingsService'
import type { ModelGroup } from '../../shared/validation/model-catalog-schemas'
import type {
  ModelSnapshot,
  ProcessedModelsSnapshot,
  TaskType
} from '../../shared/types'

/**
 * Issue #84 / Story I — captures the active models per pipeline group at the
 * moment processing starts. Called once per session from TaskQueueService:
 *   1. enqueuePipeline — first run after recording / PDF import.
 *   2. retrySession   — overwrites the previous snapshot because the user
 *      may have switched the active model between runs; the relevant
 *      provenance is what actually produced the next attempt.
 *
 * `getActiveModelId()` already runs Story A's defensive disk check, so a
 * snapshot's id is guaranteed to point at an installed model. `version`
 * comes from electron-store's `installedModelVersions` map (populated at
 * download/update time, Story B). `label` and `sizeBytes` are captured
 * from the catalog so a future catalog rename or repackage does not
 * rewrite history.
 */
function snapshotGroup(group: ModelGroup): ModelSnapshot | null {
  const id = getActiveModelId(group)
  if (!id) return null
  const def = getModelById(id)
  if (!def) return null
  const installed = getSettings().get('installedModelVersions')?.[id]
  return {
    id,
    label: def.label,
    version: installed?.version ?? 'unknown',
    sha256: def.sha256,
    sizeBytes: def.sizeBytes
  }
}

/**
 * Build a ProcessedModelsSnapshot from the planned pipeline. Each group's
 * slot is null when the corresponding step is not in `plannedSteps` (e.g.
 * summarization is skipped for sessions without an active LLM, ASR is
 * absent for PDF pipelines).
 *
 * `extraction` (pdfjs) and `ocr` (Apple Vision) are not catalog-backed
 * pipeline steps and intentionally have no snapshot — those tools ship
 * with the app binary and their identity is the app version.
 */
export function captureProcessedModels(
  plannedSteps: TaskType[]
): ProcessedModelsSnapshot {
  const planned = new Set(plannedSteps)
  return {
    capturedAt: new Date().toISOString(),
    asr: planned.has('transcription') ? snapshotGroup('asr') : null,
    diarization: planned.has('diarization') ? snapshotGroup('diarization') : null,
    ner: planned.has('anonymization') ? snapshotGroup('ner') : null,
    summarization: planned.has('summarization') ? snapshotGroup('summarization') : null
  }
}
