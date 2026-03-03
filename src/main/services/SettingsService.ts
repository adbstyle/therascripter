import Store from 'electron-store'
import type { ThemePreference } from '../../shared/types'
import type {
  PendingModelUpdate,
  InstalledModelVersion,
  AppUpdateStatus
} from '../../shared/types/ModelUpdate'

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
  installedModelVersions: Record<string, InstalledModelVersion>
  pendingModelUpdates: PendingModelUpdate[] | null
  cachedAppUpdateStatus: AppUpdateStatus | null
}

const defaults: AppSettings = {
  activeModels: {
    transcription: 'whisper-large-v3-turbo',
    diarization: 'pyannote-community-1',
    ner: 'flair-ner-german-large',
    ocr: 'apple-vision'
  },
  firstLaunchDone: false,
  consentReminderShown: false,
  modelsDownloaded: false,
  theme: 'system',
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

  return store
}

export function getSettings(): Store<AppSettings> {
  if (!store) {
    throw new Error('Settings not initialized. Call initSettings() first.')
  }
  return store
}
