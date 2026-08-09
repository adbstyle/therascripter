import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('electron', () => ({
  app: { getPath: vi.fn().mockReturnValue('/tmp/therascript-test') },
  BrowserWindow: { getAllWindows: vi.fn().mockReturnValue([]) }
}))

vi.mock('../../db/connection', () => ({
  getDataDir: () => '/tmp/therascript-test'
}))

interface ActiveModels {
  transcription: string | null
  diarization: string | null
  diarizationPipeline: string
  ner: string | null
  ocr: string
  summarization: string | null
}

interface ReconcileEventEntry {
  id: string
  timestamp: string
  group: string
  fromModelId: string | null
  toModelId: string | null
  reason: string
  status: 'pending' | 'seen'
}

interface InstalledMap {
  [id: string]: { version: string; sha256: string; installedAt: string }
}

interface FakeStoreState {
  activeModels: ActiveModels
  modelsDownloaded: boolean
  reconcileEvents: ReconcileEventEntry[]
  installedModelVersions: InstalledMap
}

let storeState: FakeStoreState

const mockSettingsStore = {
  get: vi.fn((key: keyof FakeStoreState) => storeState[key]),
  set: vi.fn(<K extends keyof FakeStoreState>(key: K, value: FakeStoreState[K]) => {
    storeState = { ...storeState, [key]: value }
  })
}
vi.mock('../SettingsService', () => ({
  getSettings: () => mockSettingsStore,
  initSettings: () => mockSettingsStore
}))

let installedFiles: Set<string>
vi.mock('fs', () => {
  const fsMock = {
    existsSync: vi.fn((p: string) => installedFiles.has(p)),
    mkdirSync: vi.fn(),
    statSync: vi.fn(),
    unlinkSync: vi.fn(),
    rmSync: vi.fn()
  }
  return { ...fsMock, default: fsMock }
})

// Import after mocks — the SUT pulls in the catalog and wraps it in
// `getModelsByGroup` filters; we don't need to stub the catalog because
// MODEL_DEFINITIONS is already a real import that ships with the app.
import {
  reconcileActiveModels,
  startModelDownload,
  getReconcileEvents,
  markReconcileEventsSeen,
  dismissReconcileEvents,
  recordInstalledVersion,
  getActiveModelId,
  getActiveModelIdBelief,
  defaultActiveModelFor
} from '../ModelDownloadService'

const MODELS_DIR = '/tmp/therascript-test/models'

function freshState(over: Partial<FakeStoreState> = {}): void {
  storeState = {
    activeModels: {
      transcription: 'whisper-large-v3-turbo',
      diarization: 'pyannote-suite',
      diarizationPipeline: 'pyannote/speaker-diarization-3.1',
      ner: 'flair-ner-german-large',
      ocr: 'apple-vision',
      summarization: null
    },
    modelsDownloaded: true,
    reconcileEvents: [],
    installedModelVersions: {},
    ...over
  }
  installedFiles = new Set()
}

function pretendInstalled(...checkPaths: string[]): void {
  for (const p of checkPaths) {
    installedFiles.add(`${MODELS_DIR}/${p}`)
  }
}

describe('reconcileActiveModels', () => {
  beforeEach(() => {
    freshState()
    vi.clearAllMocks()
  })

  it('is a no-op on truly-fresh installs (modelsDownloaded === false)', () => {
    freshState({ modelsDownloaded: false })
    pretendInstalled() // nothing installed

    const repairs = reconcileActiveModels()

    expect(repairs).toHaveLength(0)
    expect(storeState.reconcileEvents).toHaveLength(0)
    // active slots stay at the defaults — FirstLaunchScreen will gate.
    expect(storeState.activeModels.transcription).toBe('whisper-large-v3-turbo')
  })

  it('keeps the steady state when every required active model is installed and summarization is null', () => {
    // Default state: summarization slot starts null, no event expected.
    pretendInstalled(
      'asr/ggml-large-v3-turbo-q5_0.bin',
      'diarization/models--pyannote--speaker-diarization-community-1',
      'ner/hf/hub/models--xlm-roberta-large'
    )

    const repairs = reconcileActiveModels()

    expect(repairs).toHaveLength(0)
    expect(storeState.reconcileEvents).toHaveLength(0)
  })

  // Bug-zementierender Test invertiert. Default-State produziert
  // jetzt KEIN Reconcile-Event mehr, weil der summarization-Slot per Default
  // null ist und der Reconciler null+optional korrekt als steady-state behandelt.
  it('emits no event in default state when summarization is null and no Gemma file exists', () => {
    pretendInstalled(
      'asr/ggml-large-v3-turbo-q5_0.bin',
      'diarization/models--pyannote--speaker-diarization-community-1',
      'ner/hf/hub/models--xlm-roberta-large'
      // summarization NOT installed — default-state, slot is null per freshState
    )

    const repairs = reconcileActiveModels()

    expect(repairs).toHaveLength(0)
    expect(storeState.reconcileEvents).toHaveLength(0)
    expect(storeState.activeModels.summarization).toBeNull()
  })

  // Legitimer Cleanup-Pfad bleibt intakt: User hat Gemma manuell aktiviert
  // und das Modell danach gelöscht → Reconciler räumt korrekt auf und emittiert
  // ein Event. Dieses Verhalten muss erhalten bleiben.
  it('clears an optional slot when the user had it active and the file was deleted', () => {
    freshState({
      activeModels: {
        transcription: 'whisper-large-v3-turbo',
        diarization: 'pyannote-suite',
        diarizationPipeline: 'pyannote/speaker-diarization-3.1',
        ner: 'flair-ner-german-large',
        ocr: 'apple-vision',
        summarization: 'gemma-summarization' // explizit aktiviert vom User
      }
    })
    pretendInstalled(
      'asr/ggml-large-v3-turbo-q5_0.bin',
      'diarization/models--pyannote--speaker-diarization-community-1',
      'ner/hf/hub/models--xlm-roberta-large'
      // summarization-Datei vom User gelöscht
    )

    const repairs = reconcileActiveModels()

    expect(repairs).toEqual([
      {
        group: 'summarization',
        fromModelId: 'gemma-summarization',
        toModelId: null,
        reason: 'group-cleared'
      }
    ])
    expect(storeState.activeModels.summarization).toBeNull()
    expect(storeState.reconcileEvents).toHaveLength(1)
  })

  it('emits no event when an optional slot was already null and stays null', () => {
    freshState({
      activeModels: {
        transcription: 'whisper-large-v3-turbo',
        diarization: 'pyannote-suite',
        diarizationPipeline: 'pyannote/speaker-diarization-3.1',
        ner: 'flair-ner-german-large',
        ocr: 'apple-vision',
        summarization: null
      }
    })
    pretendInstalled(
      'asr/ggml-large-v3-turbo-q5_0.bin',
      'diarization/models--pyannote--speaker-diarization-community-1',
      'ner/hf/hub/models--xlm-roberta-large'
    )

    const repairs = reconcileActiveModels()

    expect(repairs).toHaveLength(0)
    expect(storeState.reconcileEvents).toHaveLength(0)
  })

  it('promotes the catalog default when an installed required slot points at a missing file', () => {
    // ASR slot points at the swiss variant which is NOT installed; the
    // multilingual default IS installed → promote it.
    freshState({
      activeModels: {
        transcription: 'whisper-large-v3-turbo-swiss',
        diarization: 'pyannote-suite',
        diarizationPipeline: 'pyannote/speaker-diarization-3.1',
        ner: 'flair-ner-german-large',
        ocr: 'apple-vision',
        summarization: null
      }
    })
    pretendInstalled(
      'asr/ggml-large-v3-turbo-q5_0.bin', // multi-lingual default
      'diarization/models--pyannote--speaker-diarization-community-1',
      'ner/hf/hub/models--xlm-roberta-large'
    )

    const repairs = reconcileActiveModels()

    expect(repairs).toEqual([
      {
        group: 'asr',
        fromModelId: 'whisper-large-v3-turbo-swiss',
        toModelId: 'whisper-large-v3-turbo',
        reason: 'default-promoted'
      }
    ])
    expect(storeState.activeModels.transcription).toBe('whisper-large-v3-turbo')
  })

  it('falls back to any installed group member when the catalog default itself is missing', () => {
    // Only the swiss variant is installed; ASR slot points at the missing default.
    freshState({
      activeModels: {
        transcription: 'whisper-large-v3-turbo',
        diarization: 'pyannote-suite',
        diarizationPipeline: 'pyannote/speaker-diarization-3.1',
        ner: 'flair-ner-german-large',
        ocr: 'apple-vision',
        summarization: null
      }
    })
    pretendInstalled(
      'asr/ggml-large-v3-turbo-swiss-q5_0.bin', // only the swiss variant
      'diarization/models--pyannote--speaker-diarization-community-1',
      'ner/hf/hub/models--xlm-roberta-large'
    )

    const repairs = reconcileActiveModels()

    const asrRepair = repairs.find((r) => r.group === 'asr')
    expect(asrRepair).toBeDefined()
    expect(asrRepair?.toModelId).toBe('whisper-large-v3-turbo-swiss')
    expect(asrRepair?.reason).toBe('default-promoted')
    expect(storeState.activeModels.transcription).toBe('whisper-large-v3-turbo-swiss')
  })

  it('emits model-removed when no installed alternative exists for a required group', () => {
    // ASR slot points at a model that is not installed and no other ASR is installed either.
    freshState({
      activeModels: {
        transcription: 'whisper-large-v3-turbo',
        diarization: 'pyannote-suite',
        diarizationPipeline: 'pyannote/speaker-diarization-3.1',
        ner: 'flair-ner-german-large',
        ocr: 'apple-vision',
        summarization: null
      }
    })
    pretendInstalled(
      'diarization/models--pyannote--speaker-diarization-community-1',
      'ner/hf/hub/models--xlm-roberta-large'
    )

    const repairs = reconcileActiveModels()

    expect(repairs).toEqual([
      {
        group: 'asr',
        fromModelId: 'whisper-large-v3-turbo',
        toModelId: null,
        reason: 'model-removed'
      }
    ])
    expect(storeState.activeModels.transcription).toBeNull()
  })

  // ─── v1→v2-NER-Upgrade-Pfad (checkPath = v2-only-Marker, Commit 08746d5) ────

  it('treats a v1 NER install (payload present, hf/ marker missing) as removed — upgrade path', () => {
    // Every v0.8.5 installation has ner/models/ner-german-large but no hf/
    // tokenizer subtree. checkPath deliberately points at the v2-only marker so
    // the First-Launch gate re-downloads the v2 tarball. The reconciler shares
    // that definition: it clears the slot and emits model-removed. This test
    // documents that behavior EXPLICITLY — it is intended, not an accident.
    pretendInstalled(
      'asr/ggml-large-v3-turbo-q5_0.bin',
      'diarization/models--pyannote--speaker-diarization-community-1',
      'ner/models/ner-german-large' // v1 payload — NOT the v2 checkPath
    )

    const repairs = reconcileActiveModels()

    expect(repairs).toEqual([
      {
        group: 'ner',
        fromModelId: 'flair-ner-german-large',
        toModelId: null,
        reason: 'model-removed'
      }
    ])
    expect(storeState.activeModels.ner).toBeNull()
    expect(storeState.reconcileEvents).toHaveLength(1)
    expect(storeState.reconcileEvents[0].reason).toBe('model-removed')
  })

  it('collapses the round-trip event when the removed model comes back (X → null → X)', () => {
    // Boot 1 of the upgrade path emitted "model-removed" and cleared the slot.
    // After the v2 re-download the model is observable again — re-promoting it
    // must REMOVE the stale pending event instead of stacking a second banner:
    // net state is unchanged, the user must not see "Modell entfernt" +
    // "Standard aktiviert" for an upgrade where nothing was removed.
    freshState({
      activeModels: {
        transcription: 'whisper-large-v3-turbo',
        diarization: 'pyannote-suite',
        diarizationPipeline: 'pyannote/speaker-diarization-3.1',
        ner: null, // cleared by the boot-1 reconcile
        ocr: 'apple-vision',
        summarization: null
      },
      reconcileEvents: [
        {
          id: 'evt-boot1',
          timestamp: '2026-08-09T10:00:00.000Z',
          group: 'ner',
          fromModelId: 'flair-ner-german-large',
          toModelId: null,
          reason: 'model-removed',
          status: 'pending'
        }
      ]
    })
    pretendInstalled(
      'asr/ggml-large-v3-turbo-q5_0.bin',
      'diarization/models--pyannote--speaker-diarization-community-1',
      'ner/hf/hub/models--xlm-roberta-large' // v2 now installed
    )

    const repairs = reconcileActiveModels()

    expect(repairs).toEqual([
      {
        group: 'ner',
        fromModelId: null,
        toModelId: 'flair-ner-german-large',
        reason: 'default-promoted'
      }
    ])
    expect(storeState.activeModels.ner).toBe('flair-ner-german-large')
    // Round-trip collapsed: no events left, no banner shown
    expect(storeState.reconcileEvents).toHaveLength(0)
  })

  it('still emits an event for a promotion that is NOT a round-trip', () => {
    // Slot was null with no matching removed-event → promotion is genuine news.
    freshState({
      activeModels: {
        transcription: 'whisper-large-v3-turbo',
        diarization: 'pyannote-suite',
        diarizationPipeline: 'pyannote/speaker-diarization-3.1',
        ner: null,
        ocr: 'apple-vision',
        summarization: null
      }
    })
    pretendInstalled(
      'asr/ggml-large-v3-turbo-q5_0.bin',
      'diarization/models--pyannote--speaker-diarization-community-1',
      'ner/hf/hub/models--xlm-roberta-large'
    )

    const repairs = reconcileActiveModels()

    expect(repairs).toHaveLength(1)
    expect(storeState.reconcileEvents).toHaveLength(1)
    expect(storeState.reconcileEvents[0].reason).toBe('default-promoted')
  })
})

// ─── startModelDownload: post-download reconcile ──────────────────────────────

describe('startModelDownload re-reconciles required slots', () => {
  beforeEach(() => {
    freshState()
    vi.clearAllMocks()
  })

  it('re-promotes a cleared required slot once the download made the model observable', () => {
    // v1-upgrade scenario, same app session: boot reconcile cleared ner → null,
    // FirstLaunchScreen ran startModelDownload, tar merged the v2 subtree.
    // Without the post-download reconcile the slot stays null until the next
    // restart — sessions processed in that window record ner:null provenance.
    freshState({
      modelsDownloaded: false,
      activeModels: {
        transcription: 'whisper-large-v3-turbo',
        diarization: 'pyannote-suite',
        diarizationPipeline: 'pyannote/speaker-diarization-3.1',
        ner: null, // cleared by boot reconcile
        ocr: 'apple-vision',
        summarization: null
      },
      reconcileEvents: [
        {
          id: 'evt-boot1',
          timestamp: '2026-08-09T10:00:00.000Z',
          group: 'ner',
          fromModelId: 'flair-ner-german-large',
          toModelId: null,
          reason: 'model-removed',
          status: 'pending'
        }
      ]
    })
    // All checkPaths present → download loop skips everything (simulates the
    // state right after tar extraction; avoids any network in the test).
    pretendInstalled(
      'asr/ggml-large-v3-turbo-q5_0.bin',
      'diarization/models--pyannote--speaker-diarization-community-1',
      'ner/hf/hub/models--xlm-roberta-large'
    )

    return startModelDownload().then(() => {
      expect(storeState.modelsDownloaded).toBe(true)
      // Slot restored in the SAME session — provenance gap closed
      expect(storeState.activeModels.ner).toBe('flair-ner-german-large')
      // Round-trip collapsed — the misleading boot-1 banner is gone
      expect(storeState.reconcileEvents).toHaveLength(0)
    })
  })
})

describe('reconcile event lifecycle', () => {
  beforeEach(() => {
    freshState()
    vi.clearAllMocks()
  })

  it('markReconcileEventsSeen transitions all pending entries to seen', () => {
    storeState.reconcileEvents = [
      {
        id: 'a',
        timestamp: '2026-04-30T10:00:00Z',
        group: 'asr',
        fromModelId: 'old',
        toModelId: null,
        reason: 'model-removed',
        status: 'pending'
      },
      {
        id: 'b',
        timestamp: '2026-04-30T10:00:01Z',
        group: 'summarization',
        fromModelId: 'gemma-summarization',
        toModelId: null,
        reason: 'group-cleared',
        status: 'pending'
      }
    ]

    const next = markReconcileEventsSeen()

    expect(next.every((e) => e.status === 'seen')).toBe(true)
    expect(storeState.reconcileEvents.every((e) => e.status === 'seen')).toBe(true)
  })

  it('markReconcileEventsSeen is a no-op when nothing is pending', () => {
    storeState.reconcileEvents = [
      {
        id: 'a',
        timestamp: '2026-04-30T10:00:00Z',
        group: 'asr',
        fromModelId: 'old',
        toModelId: null,
        reason: 'model-removed',
        status: 'seen'
      }
    ]
    const setBefore = mockSettingsStore.set.mock.calls.length
    markReconcileEventsSeen()
    expect(mockSettingsStore.set.mock.calls.length).toBe(setBefore)
  })

  it('dismissReconcileEvents wipes all events permanently', () => {
    storeState.reconcileEvents = [
      {
        id: 'a',
        timestamp: '2026-04-30T10:00:00Z',
        group: 'asr',
        fromModelId: 'old',
        toModelId: null,
        reason: 'model-removed',
        status: 'seen'
      }
    ]

    dismissReconcileEvents()

    expect(storeState.reconcileEvents).toEqual([])
    expect(getReconcileEvents()).toEqual([])
  })
})

describe('recordInstalledVersion', () => {
  beforeEach(() => {
    freshState()
    vi.clearAllMocks()
  })

  // Issue #84 Story D — keys are now `${channel}:${modelId}` so the
  // active-channel adapter can isolate per-channel install records.
  // Tests run with the default `prod` channel (no env override).
  it('writes {version: installed, sha256, installedAt} for the given id', () => {
    recordInstalledVersion('whisper-large-v3-turbo', 'abc123')

    const entry = storeState.installedModelVersions['prod:whisper-large-v3-turbo']
    expect(entry).toBeDefined()
    expect(entry.version).toBe('installed')
    expect(entry.sha256).toBe('abc123')
    expect(entry.installedAt).toMatch(/\d{4}-\d{2}-\d{2}T/)
  })

  it('preserves existing entries for other ids', () => {
    storeState.installedModelVersions['prod:flair-ner-german-large'] = {
      version: 'pre-update',
      sha256: 'def456',
      installedAt: '2026-01-01T00:00:00Z'
    }

    recordInstalledVersion('whisper-large-v3-turbo', 'abc123')

    expect(storeState.installedModelVersions['prod:flair-ner-german-large']).toEqual({
      version: 'pre-update',
      sha256: 'def456',
      installedAt: '2026-01-01T00:00:00Z'
    })
    expect(storeState.installedModelVersions['prod:whisper-large-v3-turbo'].sha256).toBe('abc123')
  })
})

// Issue #84 Story E follow-up — getActiveModelIdBelief returns the raw
// settings value without the disk-presence check, so the Settings catalog
// can expose the inconsistent state (active=true, installed=false) via the
// <ModelStatusBadge>. Executors keep using getActiveModelId (the filtered
// variant) — verified here too.
describe('getActiveModelIdBelief vs getActiveModelId', () => {
  beforeEach(() => {
    freshState()
    vi.clearAllMocks()
  })

  it('belief returns the raw settings value even when the file is missing', () => {
    // No pretendInstalled() — every checkPath misses on disk.
    expect(getActiveModelIdBelief('asr')).toBe('whisper-large-v3-turbo')
    expect(getActiveModelIdBelief('diarization')).toBe('pyannote-suite')
    expect(getActiveModelIdBelief('ner')).toBe('flair-ner-german-large')
  })

  it('the disk-checked variant masks the same state as null', () => {
    expect(getActiveModelId('asr')).toBeNull()
    expect(getActiveModelId('diarization')).toBeNull()
    expect(getActiveModelId('ner')).toBeNull()
  })

  it('belief returns null when the slot is null (post-reconciler steady state)', () => {
    storeState.activeModels.summarization = null
    expect(getActiveModelIdBelief('summarization')).toBeNull()
  })

  it('both return the same id when the file is on disk', () => {
    pretendInstalled('asr/ggml-large-v3-turbo-q5_0.bin')
    expect(getActiveModelIdBelief('asr')).toBe('whisper-large-v3-turbo')
    expect(getActiveModelId('asr')).toBe('whisper-large-v3-turbo')
  })
})

describe('defaultActiveModelFor', () => {
  it('returns the catalog default for required groups', () => {
    expect(defaultActiveModelFor('asr')).toBe('whisper-large-v3-turbo')
    expect(defaultActiveModelFor('diarization')).toBe('pyannote-suite')
    expect(defaultActiveModelFor('ner')).toBe('flair-ner-german-large')
  })

  it('returns null for optional groups', () => {
    expect(defaultActiveModelFor('summarization')).toBeNull()
  })
})
