import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import App from '../App'
import { ToastProvider } from '../contexts/ToastContext'
import { ThemeProvider } from '../contexts/ThemeContext'

// useRecording mocken: Aufnahme-Zustand pro Test steuerbar, ohne
// getUserMedia/AudioWorklet in jsdom simulieren zu müssen.
const mockRecordingState = {
  isRecording: false,
  duration: 0,
  level: 0,
  error: null as string | null,
  startRecording: vi.fn(),
  stopRecording: vi.fn()
}
vi.mock('../hooks/useRecording', () => ({
  useRecording: () => mockRecordingState
}))

const renderApp = (): ReturnType<typeof render> =>
  render(
    <ThemeProvider>
      <ToastProvider>
        <App />
      </ToastProvider>
    </ThemeProvider>
  )

const mockModelUpdate = {
  check: vi.fn().mockResolvedValue([]),
  restart: vi.fn(),
  startDownload: vi.fn(),
  getPending: vi.fn().mockResolvedValue(null),
  clearPending: vi.fn().mockResolvedValue(undefined),
  dismissVersions: vi.fn().mockResolvedValue(undefined),
  onAvailable: vi.fn().mockReturnValue(() => {}),
  onDownloadProgress: vi.fn().mockReturnValue(() => {}),
  onDownloadComplete: vi.fn().mockReturnValue(() => {}),
  onDownloadError: vi.fn().mockReturnValue(() => {})
}

beforeEach(() => {
  mockRecordingState.isRecording = false
  mockRecordingState.duration = 0
  mockRecordingState.level = 0
  mockRecordingState.error = null

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
      check: vi.fn().mockResolvedValue({
        modelUpdates: [],
        appUpdate: { available: false, latestVersion: null, checkedAt: null }
      }),
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
    },
    modelReconcile: {
      getEvents: vi.fn().mockResolvedValue([]),
      markSeen: vi.fn().mockResolvedValue([]),
      dismiss: vi.fn().mockResolvedValue(undefined)
    }
  } as typeof window.api
})

describe('App', () => {
  it('renders bottom navigation', async () => {
    renderApp()
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Transkriptionen' })).toBeInTheDocument()
      expect(screen.getByRole('tab', { name: 'Einstellungen' })).toBeInTheDocument()
    })
  })

  it('shows empty state message when no sessions', async () => {
    renderApp()

    await waitFor(() => {
      expect(screen.getByText('Keine Transkriptionen')).toBeInTheDocument()
    })
  })
})

describe('App — Navigation während der Aufnahme', () => {
  it('zeigt BottomNav während der Aufnahme, versteckt nur "Aufnahme starten"', async () => {
    mockRecordingState.isRecording = true
    renderApp()

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Transkriptionen' })).toBeInTheDocument()
      expect(screen.getByRole('tab', { name: 'Einstellungen' })).toBeInTheDocument()
    })

    expect(screen.getByText('PDF importieren')).toBeInTheDocument()
    expect(screen.queryByText('Aufnahme starten')).not.toBeInTheDocument()
  })

  it('rendert die Live-Karte für die Recording-Session in der Liste', async () => {
    mockRecordingState.isRecording = true
    mockRecordingState.duration = 95

    window.api.sessions.list = vi.fn().mockResolvedValue([
      {
        id: 'rec-1',
        title: 'Aufnahme 07.08.2026 14:02',
        type: 'audio',
        status: 'recording',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ])

    renderApp()

    await waitFor(() => {
      expect(screen.getByText('REC')).toBeInTheDocument()
    })
    expect(screen.getByText('00:01:35')).toBeInTheDocument()
    expect(screen.getByLabelText('Aufnahme stoppen')).toBeInTheDocument()
    // Auf der Sessions-Liste keine RecordingBar (Karte übernimmt)
    expect(screen.queryByLabelText('Zur laufenden Aufnahme wechseln')).not.toBeInTheDocument()
  })

  it('zeigt die RecordingBar in Settings und navigiert per Klick zurück', async () => {
    const user = userEvent.setup()
    mockRecordingState.isRecording = true
    mockRecordingState.duration = 61

    renderApp()

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Einstellungen' })).toBeInTheDocument()
    })

    await user.click(screen.getByRole('tab', { name: 'Einstellungen' }))

    const bar = await screen.findByLabelText('Zur laufenden Aufnahme wechseln')
    expect(screen.getByText('Aufnahme läuft')).toBeInTheDocument()
    expect(screen.getByText('00:01:01')).toBeInTheDocument()

    await user.click(bar)

    await waitFor(() => {
      expect(screen.queryByLabelText('Zur laufenden Aufnahme wechseln')).not.toBeInTheDocument()
      expect(screen.getByText('PDF importieren')).toBeInTheDocument()
    })
  })

  it('zeigt Aufnahmefehler als Toast', async () => {
    mockRecordingState.error = 'Mikrofonzugriff wurde verweigert.'
    renderApp()

    await waitFor(() => {
      expect(screen.getByText('Mikrofonzugriff wurde verweigert.')).toBeInTheDocument()
    })
  })
})
