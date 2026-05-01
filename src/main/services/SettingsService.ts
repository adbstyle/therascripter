import Store from 'electron-store'
import type { ThemePreference } from '../../shared/types'
import type {
  PendingModelUpdate,
  InstalledModelVersion,
  AppUpdateStatus
} from '../../shared/types/ModelUpdate'
import type { ReconcileEvent } from '../../shared/types/ReconcileEvent'
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
    // null when no model is selected for the slot — optional groups (summarization)
    // ship deactivated; required groups become null only transiently when the
    // active model is missing on disk and no installed default exists, in which
    // case the FirstLaunchScreen forces re-download. The bootstrap reconciler
    // (`reconcileActiveModels`) maintains the invariant that either the slot
    // points to an installed catalog model or it is null.
    transcription: string | null
    diarization: string | null
    diarizationPipeline: DiarizationPipeline
    ner: string | null
    ocr: string
    summarization: string | null
  }
  firstLaunchDone: boolean
  consentReminderShown: boolean
  backgroundReminderShown: boolean
  modelsDownloaded: boolean
  theme: ThemePreference
  reviewPanelOpen: boolean
  installedModelVersions: Record<string, InstalledModelVersion>
  pendingModelUpdates: PendingModelUpdate[] | null
  cachedAppUpdateStatus: AppUpdateStatus | null
  reconcileEvents: ReconcileEvent[]
}

const defaults: AppSettings = {
  activeModels: {
    transcription: 'whisper-large-v3-turbo',
    diarization: 'pyannote-suite',
    diarizationPipeline: DEFAULT_DIARIZATION_PIPELINE,
    ner: 'flair-ner-german-large',
    ocr: 'apple-vision',
    summarization: 'gemma-summarization'
  },
  firstLaunchDone: false,
  consentReminderShown: false,
  backgroundReminderShown: false,
  modelsDownloaded: false,
  theme: 'system',
  reviewPanelOpen: false,
  installedModelVersions: {},
  pendingModelUpdates: null,
  cachedAppUpdateStatus: null,
  reconcileEvents: []
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

  // null is a valid post-migration state for the diarization slot (cleared by
  // the reconciler when the suite is missing on disk); only fire the legacy
  // reset for known-bad string IDs, not for null.
  if (
    active.diarization !== null &&
    (!knownDiarIds.has(active.diarization) || active.diarization !== EXPECTED_DIAR)
  ) {
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

  // Defensiv: unbekannte activeModels.ner-Werte (z. B. ai4privacy/gliner aus
  // einer rückgängig gemachten Multi-Backend-Iteration) auf den einzig
  // verfügbaren NER-Default zurücksetzen, damit AnonymizationService nicht
  // mit "ungültiges NER-Modell" abbricht.
  const knownNerIds = new Set(
    getModelDefinitions()
      .filter((m) => m.group === 'ner')
      .map((m) => m.id)
  )
  const EXPECTED_NER = 'flair-ner-german-large'
  const currentNer = store.get('activeModels').ner
  if (currentNer === null || !knownNerIds.has(currentNer)) {
    console.warn(
      `[settings-migration] activeModels.ner="${currentNer}" unbekannt → reset auf "${EXPECTED_NER}"`
    )
    store.set('activeModels', {
      ...store.get('activeModels'),
      ner: EXPECTED_NER
    })
  }

  // Defensiv: Bestehende electron-store-Instanzen haben kein activeModels.summarization,
  // weil das Feld erst mit dem lokalen LLM eingeführt wurde. defaults füllt nested keys
  // nicht nach, also Wert hier explizit setzen, falls nicht vorhanden.
  const currentSummarization = (
    store.get('activeModels') as { summarization?: string | null }
  ).summarization
  if (typeof currentSummarization !== 'string' && currentSummarization !== null) {
    store.set('activeModels', {
      ...store.get('activeModels'),
      summarization: 'gemma-summarization'
    })
  }

  // Issue #84 / Story C — convert the legacy '' sentinel ("deaktiviert") to null,
  // matching the new `string | null` type. The reconciler relies on null to
  // detect "no active model" without ambiguity. `ocr` and `diarizationPipeline`
  // are not user-clearable and stay non-null.
  const activeForLegacy = store.get('activeModels') as Record<string, string | null>
  const legacyEmptyKeys = ['transcription', 'diarization', 'ner', 'summarization'] as const
  let activeChanged = false
  const next = { ...activeForLegacy }
  for (const key of legacyEmptyKeys) {
    if (next[key] === '') {
      next[key] = null
      activeChanged = true
    }
  }
  if (activeChanged) {
    store.set('activeModels', next as AppSettings['activeModels'])
  }

  // Issue #84 / Story C — ensure reconcileEvents exists for stores from
  // previous app versions (electron-store does not deep-merge top-level defaults
  // into already-persisted instances).
  if (!Array.isArray(store.get('reconcileEvents'))) {
    store.set('reconcileEvents', [])
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
