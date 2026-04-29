import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import App from '../App'

const mockModelUpdate = {
  check: vi.fn().mockResolvedValue([]),
  restart: vi.fn(),
  startDownload: vi.fn(),
  getPending: vi.fn().mockResolvedValue(null),
  clearPending: vi.fn().mockResolvedValue(undefined),
  onAvailable: vi.fn().mockReturnValue(() => {}),
  onDownloadProgress: vi.fn().mockReturnValue(() => {}),
  onDownloadComplete: vi.fn().mockReturnValue(() => {}),
  onDownloadError: vi.fn().mockReturnValue(() => {})
}

beforeEach(() => {
  window.api = {
    sessions: {
      list: vi.fn().mockResolvedValue([]),
      delete: vi.fn(),
      rename: vi.fn()
    },
    recording: {
      start: vi.fn(),
      stop: vi.fn(),
      sendData: vi.fn(),
      onDuration: vi.fn().mockReturnValue(() => {}),
      onError: vi.fn().mockReturnValue(() => {}),
      onAutoStopped: vi.fn().mockReturnValue(() => {})
    },
    settings: {
      get: vi.fn().mockResolvedValue(false),
      set: vi.fn().mockResolvedValue(undefined)
    },
    tasks: {
      getSessionTasks: vi.fn().mockResolvedValue([]),
      isProcessing: vi.fn().mockResolvedValue(false),
      retry: vi.fn().mockResolvedValue(undefined),
      onProgress: vi.fn().mockReturnValue(() => {}),
      onStarted: vi.fn().mockReturnValue(() => {}),
      onCompleted: vi.fn().mockReturnValue(() => {}),
      onError: vi.fn().mockReturnValue(() => {}),
      onQueuePositions: vi.fn().mockReturnValue(() => {})
    },
    blocklist: {
      list: vi.fn().mockResolvedValue([]),
      add: vi.fn(),
      update: vi.fn(),
      delete: vi.fn()
    },
    import: {
      pdf: vi.fn().mockResolvedValue([]),
      showPDFDialog: vi.fn().mockResolvedValue([]),
      getPathForFile: vi.fn().mockReturnValue('')
    },
    review: {
      load: vi.fn(),
      save: vi.fn(),
      exportClipboard: vi.fn()
    },
    system: {
      aboutInfo: vi.fn().mockResolvedValue({}),
      uninstall: vi.fn(),
      openInFinder: vi.fn()
    },
    modelDownload: {
      status: vi.fn().mockResolvedValue({ modelsReady: true, models: [] }),
      checkDiskSpace: vi
        .fn()
        .mockResolvedValue({ sufficient: true, availableBytes: 0, requiredBytes: 0 }),
      start: vi.fn(),
      onStatus: vi.fn().mockReturnValue(() => {})
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
    pipeline: {
      getDiarization: vi.fn().mockResolvedValue('pyannote/speaker-diarization-3.1'),
      setDiarization: vi.fn().mockResolvedValue('pyannote/speaker-diarization-3.1'),
      listDiarization: vi.fn().mockResolvedValue([])
    },
    modelUpdate: mockModelUpdate,
    appUpdate: {
      getStatus: vi.fn().mockResolvedValue(null),
      check: vi.fn().mockResolvedValue({ modelUpdates: [], appUpdate: { available: false, latestVersion: null, checkedAt: null } }),
      openReleasePage: vi.fn(),
      onStatus: vi.fn().mockReturnValue(() => {})
    },
    summary: {
      get: vi.fn().mockResolvedValue(null),
      updateTitle: vi.fn().mockResolvedValue(undefined),
      updateText: vi.fn().mockResolvedValue(undefined)
    },
    nav: {
      onOpenSettings: vi.fn().mockReturnValue(() => {})
    }
  } as typeof window.api
})

describe('App', () => {
  it('renders bottom navigation', async () => {
    render(<App />)
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Transkriptionen' })).toBeInTheDocument()
      expect(screen.getByRole('tab', { name: 'Einstellungen' })).toBeInTheDocument()
    })
  })

  it('shows empty state message when no sessions', async () => {
    render(<App />)

    await waitFor(() => {
      expect(screen.getByText('Keine Transkriptionen')).toBeInTheDocument()
    })
  })
})
