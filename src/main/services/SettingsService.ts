import Store from 'electron-store'
import type { ThemePreference } from '../../shared/types'
import type {
  PendingModelUpdate,
  InstalledModelVersion,
  AppUpdateStatus
} from '../../shared/types/ModelUpdate'
import { getModelDefinitions } from './ModelDownloadService'
import {
  DIARIZATION_PIPELINES,
  DEFAULT_DIARIZATION_PIPELINE,
  type DiarizationPipeline
} from '../../shared/validation/model-catalog-schemas'

export type { DiarizationPipeline }
export { DIARIZATION_PIPELINES, DEFAULT_DIARIZATION_PIPELINE }

export interface AppSettings {
  activeModels: {
    transcription: string
    diarization: string
    diarizationPipeline: DiarizationPipeline
    ner: string
    ocr: string
  }
  firstLaunchDone: boolean
  consentReminderShown: boolean
  modelsDownloaded: boolean
  theme: ThemePreference
  reviewPanelOpen: boolean
  installedModelVersions: Record<string, InstalledModelVersion>
  pendingModelUpdates: PendingModelUpdate[] | null
  cachedAppUpdateStatus: AppUpdateStatus | null
}

const defaults: AppSettings = {
  activeModels: {
    transcription: 'whisper-large-v3-turbo',
    diarization: 'pyannote-suite',
    diarizationPipeline: DEFAULT_DIARIZATION_PIPELINE,
    ner: 'flair-ner-german-large',
    ocr: 'apple-vision'
  },
  firstLaunchDone: false,
  consentReminderShown: false,
  modelsDownloaded: false,
  theme: 'system',
  reviewPanelOpen: false,
  installedModelVersions: {},
  pendingModelUpdates: null,
  cachedAppUpdateStatus: null
}

let store: Store<AppSettings> | null = null

/**
 * Inferiert die gewünschte Diarization-Pipeline aus einer alten
 * Model-ID. Unbekannte Werte werden auf den Default gesetzt.
 */
function inferPipelineFromLegacyId(legacyId: string | undefined): DiarizationPipeline {
  if (legacyId === 'pyannote-speaker-diarization-community-1') {
    return 'pyannote/speaker-diarization-community-1'
  }
  // Der alte 'pyannote-community-1' Key lud faktisch 3.1 — auf 3.1 mappen.
  return DEFAULT_DIARIZATION_PIPELINE
}

export function initSettings(): Store<AppSettings> {
  if (store) return store

  store = new Store<AppSettings>({
    name: 'settings',
    defaults
  })

  // Migration 2026-04-24 — Konsolidierung auf pyannote-suite.
  // pyannote 4.x koppelt 3.1 und community-1 durch hardcoded PLDA-Loading,
  // beide Pipelines leben daher im selben Installations-Paket; die Wahl
  // zwischen ihnen ist eine Runtime-Konfiguration (diarizationPipeline).
  // Migration deckt alle früheren Diarization-IDs + unbekannte/manipulierte
  // Werte ab. Kann nach 2-3 Releases entfernt werden.
  const active = store.get('activeModels')
  const knownDiarIds = new Set(
    getModelDefinitions()
      .filter((m) => m.group === 'diarization')
      .map((m) => m.id)
  )
  const EXPECTED_DIAR = 'pyannote-suite'

  if (!knownDiarIds.has(active.diarization) || active.diarization !== EXPECTED_DIAR) {
    const inferredPipeline = inferPipelineFromLegacyId(active.diarization)
    console.warn(
      `[settings-migration] activeModels.diarization="${active.diarization}" → reset auf "${EXPECTED_DIAR}" (Pipeline: ${inferredPipeline})`
    )
    store.set('activeModels', {
      ...active,
      diarization: EXPECTED_DIAR,
      diarizationPipeline: inferredPipeline
    })
  }

  // Defensiv: ungültigen Pipeline-Wert auf Default zurücksetzen.
  const currentPipeline = store.get('activeModels').diarizationPipeline
  if (!DIARIZATION_PIPELINES.includes(currentPipeline as DiarizationPipeline)) {
    console.warn(
      `[settings-migration] activeModels.diarizationPipeline="${currentPipeline}" ungültig → reset auf Default`
    )
    store.set('activeModels', {
      ...store.get('activeModels'),
      diarizationPipeline: DEFAULT_DIARIZATION_PIPELINE
    })
  }

  // installedModelVersions: Altlasten-Keys (Legacy + PR-Zwischenstände) auf den neuen
  // Key umbenennen, sonst bleiben sie für immer verwaist (UpdateCheckService iteriert
  // über Manifest-IDs, nicht über installed-keys).
  const installed = { ...store.get('installedModelVersions') }
  const legacyInstalledKeys = [
    'pyannote-community-1',
    'pyannote-speaker-diarization-3.1',
    'pyannote-speaker-diarization-community-1'
  ]
  let installedChanged = false
  for (const legacyKey of legacyInstalledKeys) {
    if (installed[legacyKey]) {
      installed[EXPECTED_DIAR] = installed[EXPECTED_DIAR] ?? installed[legacyKey]
      delete installed[legacyKey]
      installedChanged = true
    }
  }
  if (installedChanged) {
    store.set('installedModelVersions', installed)
  }

  return store
}

export function getSettings(): Store<AppSettings> {
  if (!store) {
    throw new Error('Settings not initialized. Call initSettings() first.')
  }
  return store
}
