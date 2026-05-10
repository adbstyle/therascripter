import Store from 'electron-store'
import type { ThemePreference } from '../../shared/types'
import type {
  PendingModelUpdate,
  InstalledModelVersion,
  AppUpdateStatus
} from '../../shared/types/ModelUpdate'
import type { ReconcileEvent } from '../../shared/types/ReconcileEvent'
import { getModelDefinitions, defaultActiveModelFor } from './ModelDownloadService'
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
  /**
   * Issue #84 / Story F+G — manifest entries the user has actively dismissed.
   * Each entry is `${modelId}@${sha256}`; the SHA-256 is what makes the entry
   * obsolete on its own when a new manifest publishes a different hash for the
   * same id, so no explicit cleanup is needed.
   */
  dismissedManifestVersions: string[]
}

const defaults: AppSettings = {
  activeModels: {
    transcription: 'whisper-large-v3-turbo',
    diarization: 'pyannote-suite',
    diarizationPipeline: DEFAULT_DIARIZATION_PIPELINE,
    ner: 'flair-ner-german-large',
    ocr: 'apple-vision',
    // Issue #103 — optionale Gruppen starten null. defaultActiveModelFor kann
    // hier nicht direkt aufgerufen werden, weil ModelDownloadService getSettings()
    // importiert (zirkuläre Init). Wert hardcoden + Helper konsumiert die gleiche
    // Invariante in der Migration unten.
    summarization: null
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
  reconcileEvents: [],
  dismissedManifestVersions: []
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
  //
  // null ist ein gültiger Post-Reconciler-Zustand (Story C clears the slot
  // when the model file is missing on disk) und darf hier NICHT zurück auf
  // den Default gesetzt werden — sonst stösst jeder Boot ein neues
  // ReconcileEvent an: initSettings setzt ner = EXPECTED_NER, der gleich
  // danach laufende Reconciler räumt es wieder auf null und schreibt ein
  // pending Event. Spiegelt das Diarization-Pattern weiter oben.
  const knownNerIds = new Set(
    getModelDefinitions()
      .filter((m) => m.group === 'ner')
      .map((m) => m.id)
  )
  const EXPECTED_NER = 'flair-ner-german-large'
  const currentNer = store.get('activeModels').ner
  if (currentNer !== null && !knownNerIds.has(currentNer)) {
    console.warn(
      `[settings-migration] activeModels.ner="${currentNer}" unbekannt → reset auf "${EXPECTED_NER}"`
    )
    store.set('activeModels', {
      ...store.get('activeModels'),
      ner: EXPECTED_NER
    })
  }

  // Issue #103 — pre-LLM-Stores haben keinen summarization-Key (Feld kam mit dem
  // lokalen LLM). electron-store füllt nested keys nicht nach, also setzen wir
  // den Default-Wert für die optionale Gruppe (= null) explizit. Frühere Versionen
  // dieser Migration schrieben blind 'gemma-summarization' und triggerten dadurch
  // ein irreführendes Reconcile-Event ("Bisher aktiv: gemma-summarization") für
  // User, die das Modell nie heruntergeladen hatten.
  const currentSummarization = (
    store.get('activeModels') as { summarization?: string | null }
  ).summarization
  if (typeof currentSummarization !== 'string' && currentSummarization !== null) {
    store.set('activeModels', {
      ...store.get('activeModels'),
      summarization: defaultActiveModelFor('summarization')
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

  // Issue #84 / Story F+G — same reasoning for dismissedManifestVersions.
  if (!Array.isArray(store.get('dismissedManifestVersions'))) {
    store.set('dismissedManifestVersions', [])
  }

  // installedModelVersions: Altlasten-Keys (Legacy + PR-Zwischenstände) auf den neuen
  // Key umbenennen, sonst bleiben sie für immer verwaist (UpdateCheckService iteriert
  // über Manifest-IDs, nicht über installed-keys). Läuft VOR der Channel-Tag-Migration
  // weiter unten, weil die Renames untagged-Keys erwarten.
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

  // Issue #84 / Story D — channel-tag migration. Pre-D installs wrote raw
  // model-id keys; tag them as `prod:` so the channel-aware adapter (see
  // InstalledVersionsStore.ts) can read them. Already-tagged keys (anything
  // containing `:`) are passed through unchanged. Idempotent.
  const installedForChannelTag = { ...store.get('installedModelVersions') }
  let channelTagChanged = false
  const tagged: Record<string, InstalledModelVersion> = {}
  for (const [key, val] of Object.entries(installedForChannelTag)) {
    if (key.includes(':')) {
      tagged[key] = val
    } else {
      tagged[`prod:${key}`] = val
      channelTagChanged = true
    }
  }
  if (channelTagChanged) {
    store.set('installedModelVersions', tagged)
  }

  return store
}

export function getSettings(): Store<AppSettings> {
  if (!store) {
    throw new Error('Settings not initialized. Call initSettings() first.')
  }
  return store
}

/** Test-only — clears the module-level singleton so a fresh initSettings() runs. */
export function _resetSettingsForTests(): void {
  store = null
}
