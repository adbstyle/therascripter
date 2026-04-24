import Store from 'electron-store'
import type { ThemePreference } from '../../shared/types'
import type {
  PendingModelUpdate,
  InstalledModelVersion,
  AppUpdateStatus
} from '../../shared/types/ModelUpdate'
import { getModelDefinitions } from './ModelDownloadService'

export interface AppSettings {
  activeModels: {
    transcription: string
    diarization: string
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
    diarization: 'pyannote-speaker-diarization-3.1',
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

export function initSettings(): Store<AppSettings> {
  if (store) return store

  store = new Store<AppSettings>({
    name: 'settings',
    defaults
  })

  // Migration 2026-04-23 — Diarization-Modell-ID-Rename + defensive Repair.
  // Deckt ab: altes 'pyannote-community-1', manipulierte Werte, Downgrade-Rückstände.
  // Kann nach 2-3 Releases entfernt werden.
  const active = store.get('activeModels')
  const knownDiarIds = new Set(
    getModelDefinitions()
      .filter((m) => m.group === 'diarization')
      .map((m) => m.id)
  )
  const DEFAULT_DIAR = 'pyannote-speaker-diarization-3.1'

  if (!knownDiarIds.has(active.diarization)) {
    console.warn(
      `[settings-migration] activeModels.diarization="${active.diarization}" unbekannt → reset auf "${DEFAULT_DIAR}"`
    )
    store.set('activeModels', { ...active, diarization: DEFAULT_DIAR })
  }

  // installedModelVersions: Altlasten-Key mit-migrieren, sonst bleibt er für immer
  // verwaist (UpdateCheckService iteriert über Manifest-IDs, nicht über installed-keys).
  const installed = { ...store.get('installedModelVersions') }
  if (installed['pyannote-community-1']) {
    installed[DEFAULT_DIAR] = installed[DEFAULT_DIAR] ?? installed['pyannote-community-1']
    delete installed['pyannote-community-1']
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
