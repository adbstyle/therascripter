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
      onProgress: vi.fn().mockReturnValue(() => {}),
      onCompleted: vi.fn().mockReturnValue(() => {}),
      onError: vi.fn().mockReturnValue(() => {})
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
      checkDiskSpace: vi.fn().mockResolvedValue({ sufficient: true, availableBytes: 0, requiredBytes: 0 }),
      start: vi.fn(),
      onStatus: vi.fn().mockReturnValue(() => {})
    },
    modelUpdate: mockModelUpdate
  } as typeof window.api
})

describe('App', () => {
  it('renders sidebar navigation', async () => {
    render(<App />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Sitzungen' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Einstellungen' })).toBeInTheDocument()
    })
  })

  it('shows empty state message when no sessions', async () => {
    render(<App />)

    await waitFor(() => {
      expect(screen.getByText('Keine Sitzungen')).toBeInTheDocument()
    })
  })
})
