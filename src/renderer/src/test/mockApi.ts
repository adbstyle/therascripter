import { vi } from 'vitest'
import type { IpcApi } from '../../../shared/types/IpcApi'
import type { AppUpdateState } from '../../../shared/types/AppUpdate'
import type { Session } from '../../../shared/types'

/**
 * Vollständiges `window.api` für Renderer-Tests (Epic #192). Jede Methode ist
 * ein `vi.fn` mit harmloser Vorgabe, jedes `on*` meldet sich an und liefert
 * eine Abmeldung. Über `emitApiEvent` lösen Tests Push-Events aus.
 *
 *   window.api = createMockApi({ sessions: { list: vi.fn().mockResolvedValue([s]) } })
 *   emitApiEvent(window.api, 'sessions.onChanged', { deletedIds: ['s1'] })
 *
 * Spätere Bereiche (z. B. Patientendossiers) hängen hier je einen Block an.
 */
export type MockApiOverrides = {
  [K in keyof IpcApi]?: Partial<IpcApi[K]>
}

type Listener = (...args: unknown[]) => void
const registries = new WeakMap<object, Map<string, Set<Listener>>>()

export const IDLE_APP_UPDATE: AppUpdateState = {
  phase: 'idle',
  currentVersion: '0.9.0',
  version: null,
  sizeBytes: null,
  appSizeBytes: null,
  models: [],
  diskNeedBytes: null,
  progress: null,
  manualDownload: false,
  autoUpdate: true,
  installPending: false,
  message: null,
  unsupportedReason: null,
  manualVersion: null,
  checkedAt: null,
  checkFailed: false
}

export function createMockApi(overrides: MockApiOverrides = {}): IpcApi {
  const listeners = new Map<string, Set<Listener>>()
  const on = (key: string) =>
    vi.fn((callback: Listener) => {
      const set = listeners.get(key) ?? new Set<Listener>()
      set.add(callback)
      listeners.set(key, set)
      return () => {
        set.delete(callback)
      }
    })

  const defaults: IpcApi = {
    sessions: {
      list: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(true),
      rename: vi.fn().mockResolvedValue(null),
      setDocumentDate: vi.fn().mockResolvedValue({ ok: true }),
      onChanged: on('sessions.onChanged')
    },
    recording: {
      start: vi.fn().mockResolvedValue({ sessionId: 'rec-1' }),
      stop: vi.fn().mockResolvedValue({ durationSeconds: 0 }),
      sendData: vi.fn(),
      onDuration: on('recording.onDuration'),
      onError: on('recording.onError'),
      onAutoStopped: on('recording.onAutoStopped')
    },
    settings: {
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined)
    },
    tasks: {
      getSessionTasks: vi.fn().mockResolvedValue([]),
      isProcessing: vi.fn().mockResolvedValue(false),
      retry: vi.fn().mockResolvedValue(undefined),
      onProgress: on('tasks.onProgress'),
      onStarted: on('tasks.onStarted'),
      onCompleted: on('tasks.onCompleted'),
      onError: on('tasks.onError'),
      onQueuePositions: on('tasks.onQueuePositions')
    },
    blocklist: {
      list: vi.fn().mockResolvedValue([]),
      add: vi.fn(),
      update: vi.fn().mockResolvedValue(null),
      delete: vi.fn().mockResolvedValue(true)
    },
    import: {
      pdf: vi.fn().mockResolvedValue([]),
      showPDFDialog: vi.fn().mockResolvedValue([]),
      getPathForFile: vi.fn().mockReturnValue('')
    },
    review: {
      load: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
      exportClipboard: vi.fn().mockResolvedValue(undefined)
    },
    system: {
      aboutInfo: vi.fn().mockResolvedValue({ version: '0.10.1' }),
      uninstall: vi.fn().mockResolvedValue(false),
      openInFinder: vi.fn().mockResolvedValue(undefined)
    },
    modelDownload: {
      status: vi.fn().mockResolvedValue({ modelsReady: true, models: [] }),
      checkDiskSpace: vi
        .fn()
        .mockResolvedValue({ sufficient: true, availableBytes: 0, requiredBytes: 0 }),
      start: vi.fn().mockResolvedValue(undefined),
      onStatus: on('modelDownload.onStatus')
    },
    modelCatalog: {
      list: vi.fn().mockResolvedValue([]),
      listAsr: vi.fn().mockResolvedValue([]),
      download: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue([]),
      setActive: vi.fn().mockResolvedValue([]),
      clearActive: vi.fn().mockResolvedValue([]),
      cancelDownload: vi.fn().mockResolvedValue(undefined)
    },
    modelReconcile: {
      getEvents: vi.fn().mockResolvedValue([]),
      markSeen: vi.fn().mockResolvedValue([]),
      dismiss: vi.fn().mockResolvedValue(undefined)
    },
    pipeline: {
      getDiarization: vi.fn().mockResolvedValue('pyannote/speaker-diarization-3.1'),
      setDiarization: vi.fn().mockResolvedValue('pyannote/speaker-diarization-3.1'),
      listDiarization: vi.fn().mockResolvedValue([])
    },
    appUpdate: {
      getState: vi.fn().mockResolvedValue(IDLE_APP_UPDATE),
      check: vi.fn().mockResolvedValue(IDLE_APP_UPDATE),
      download: vi.fn().mockResolvedValue(undefined),
      cancelDownload: vi.fn().mockResolvedValue(undefined),
      install: vi.fn(),
      setAutoUpdate: vi.fn().mockResolvedValue(undefined),
      openInstallGuide: vi.fn().mockResolvedValue(undefined),
      onState: on('appUpdate.onState')
    },
    summary: {
      get: vi.fn().mockResolvedValue(null),
      updateTitle: vi.fn().mockResolvedValue(null),
      updateText: vi.fn().mockResolvedValue(null),
      missingReason: vi.fn().mockResolvedValue(null),
      regenerate: vi.fn().mockResolvedValue(false),
      onChanged: on('summary.onChanged')
    },
    microphone: {
      getState: vi.fn().mockResolvedValue({ status: 'granted', previouslyGranted: true }),
      ensureAccess: vi.fn().mockResolvedValue('granted'),
      dismissHint: vi.fn().mockResolvedValue(undefined),
      openSettings: vi.fn().mockResolvedValue(undefined)
    },
    toolHealth: {
      getState: vi.fn().mockResolvedValue({ status: 'ok', tools: [], bundlePath: '' }),
      recheck: vi.fn().mockResolvedValue(null),
      openGuide: vi.fn().mockResolvedValue(undefined),
      onState: on('toolHealth.onState')
    },
    nav: {
      initialSidebarOpen: true,
      onOpenSettings: on('nav.onOpenSettings'),
      onCommand: on('nav.onCommand')
    },
    dossiers: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      update: vi.fn(),
      deletePreview: vi.fn().mockResolvedValue(null),
      delete: vi.fn(),
      timeline: vi.fn().mockResolvedValue([]),
      listForSession: vi.fn().mockResolvedValue([]),
      assign: vi.fn().mockResolvedValue({ ok: true }),
      unassign: vi.fn().mockResolvedValue({ ok: true }),
      onChanged: on('dossiers.onChanged')
    },
    search: {
      open: vi.fn().mockResolvedValue({ model: { status: 'ready' }, semantic: 'ready' }),
      retryModel: vi.fn().mockResolvedValue({ model: { status: 'ready' }, semantic: 'ready' }),
      onAvailabilityChanged: on('search.onAvailabilityChanged'),
      query: vi.fn().mockImplementation(async (input: { requestId: number }) => ({
        requestId: input.requestId,
        dossiers: [],
        results: [],
        truncated: false,
        semantic: 'model-missing'
      })),
      recentList: vi.fn().mockResolvedValue([]),
      recentRemember: vi.fn().mockResolvedValue(undefined),
      recentClear: vi.fn().mockResolvedValue(undefined),
      semantic: vi.fn().mockImplementation(async (input: { requestId: number }) => ({
        requestId: input.requestId,
        dossiers: [],
        results: [],
        truncated: false,
        semantic: 'model-missing'
      }))
    },
    pendingEdits: {
      onFlushRequest: on('pendingEdits.onFlushRequest')
    },
    viewMode: {
      initial: 'pseudonymized',
      set: vi.fn().mockResolvedValue(undefined)
    }
  }

  const api = { ...defaults } as Record<string, unknown>
  for (const [area, partial] of Object.entries(overrides)) {
    api[area] = { ...(defaults as unknown as Record<string, object>)[area], ...partial }
  }
  registries.set(api, listeners)
  return api as unknown as IpcApi
}

/** Löst ein Push-Event aus, z. B. `emitApiEvent(window.api, 'nav.onCommand', 'back')`. */
export function emitApiEvent(api: IpcApi, event: string, ...args: unknown[]): void {
  const listeners = registries.get(api)?.get(event)
  if (!listeners) return
  for (const listener of [...listeners]) listener(...args)
}

/** Vollständige Sitzung mit neutralen Werten für Listen-Tests. */
export function makeSession(overrides: Partial<Session> = {}): Session {
  const now = new Date().toISOString()
  return {
    id: 'session-1',
    title: 'Sitzung 14.02.2026 14:30',
    type: 'audio',
    status: 'review',
    audioPath: null,
    transcriptPath: null,
    anonymizedPath: null,
    diarizationPath: null,
    alignedTranscriptPath: null,
    pdfPath: null,
    extractedPath: null,
    entityMap: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    reviewAt: null,
    wordCount: null,
    anonymizationCount: null,
    summary: null,
    summaryModelId: null,
    summarizedAt: null,
    plannedSteps: null,
    retryCount: 0,
    pdfHasScannedPages: null,
    processedWithModels: null,
    ...overrides
  }
}
