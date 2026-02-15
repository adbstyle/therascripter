import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { groupSessionsByTime } from '../../utils/groupSessionsByTime'
import SessionDashboard from '../SessionDashboard'
import type { Session } from '../../../../shared/types'

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'test-id',
    title: 'Sitzung 14.02.2026 14:30',
    type: 'audio',
    status: 'review',
    audioPath: null,
    transcriptPath: null,
    anonymizedPath: null,
    diarizationPath: null,
    pdfPath: null,
    entityMap: null,
    errorMessage: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  }
}

describe('groupSessionsByTime', () => {
  it('returns empty map for empty sessions', () => {
    const result = groupSessionsByTime([])
    expect(result.size).toBe(0)
  })

  it('groups sessions created today into Heute', () => {
    const session = makeSession({ createdAt: new Date().toISOString() })
    const result = groupSessionsByTime([session])

    expect(result.get('Heute')).toHaveLength(1)
  })

  it('groups sessions created yesterday into Gestern', () => {
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    yesterday.setHours(12, 0, 0, 0)
    const session = makeSession({ createdAt: yesterday.toISOString() })
    const result = groupSessionsByTime([session])

    expect(result.get('Gestern')).toHaveLength(1)
  })

  it('groups older sessions into Älter', () => {
    const old = new Date()
    old.setDate(old.getDate() - 30)
    const session = makeSession({ createdAt: old.toISOString() })
    const result = groupSessionsByTime([session])

    expect(result.get('Älter')).toHaveLength(1)
  })

  it('groups multiple sessions into correct groups', () => {
    const today = makeSession({ id: '1', createdAt: new Date().toISOString() })
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    yesterday.setHours(12, 0, 0, 0)
    const yesterdaySession = makeSession({ id: '2', createdAt: yesterday.toISOString() })

    const result = groupSessionsByTime([today, yesterdaySession])

    expect(result.get('Heute')).toHaveLength(1)
    expect(result.get('Gestern')).toHaveLength(1)
  })
})

const mockSessions = {
  list: vi.fn(),
  delete: vi.fn(),
  rename: vi.fn()
}

beforeEach(() => {
  window.api = {
    sessions: mockSessions,
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
      uninstall: vi.fn()
    },
    modelDownload: {
      status: vi.fn().mockResolvedValue({ modelsReady: true, models: [] }),
      checkDiskSpace: vi.fn().mockResolvedValue({ sufficient: true, availableBytes: 0, requiredBytes: 0 }),
      start: vi.fn(),
      onStatus: vi.fn().mockReturnValue(() => {})
    }
  } as typeof window.api
  vi.clearAllMocks()
})

describe('SessionDashboard', () => {
  it('shows loading state initially', () => {
    mockSessions.list.mockReturnValue(new Promise(() => {}))
    render(<SessionDashboard />)
    expect(screen.getByText('Laden...')).toBeInTheDocument()
  })

  it('shows empty state when no sessions', async () => {
    mockSessions.list.mockResolvedValue([])
    render(<SessionDashboard />)

    await waitFor(() => {
      expect(screen.getByText('Keine Sitzungen')).toBeInTheDocument()
    })
  })

  it('shows error state on API failure', async () => {
    mockSessions.list.mockRejectedValue(new Error('DB error'))
    render(<SessionDashboard />)

    await waitFor(() => {
      expect(screen.getByText('DB error')).toBeInTheDocument()
    })
  })

  it('renders sessions grouped by time', async () => {
    const sessions = [
      makeSession({ id: '1', title: 'Heute Session', createdAt: new Date().toISOString() })
    ]
    mockSessions.list.mockResolvedValue(sessions)
    render(<SessionDashboard />)

    await waitFor(() => {
      expect(screen.getByText('Heute')).toBeInTheDocument()
      expect(screen.getByText('Heute Session')).toBeInTheDocument()
    })
  })

  it('shows delete confirmation dialog', async () => {
    const user = userEvent.setup()
    const sessions = [makeSession({ id: '1', title: 'My Session' })]
    mockSessions.list.mockResolvedValue(sessions)
    render(<SessionDashboard />)

    await waitFor(() => {
      expect(screen.getByText('My Session')).toBeInTheDocument()
    })

    await user.click(screen.getByLabelText('Sitzungsoptionen'))
    await user.click(screen.getByText('L\u00f6schen'))

    expect(screen.getByText('Sitzung l\u00f6schen')).toBeInTheDocument()
  })

  it('shows rename dialog', async () => {
    const user = userEvent.setup()
    const sessions = [makeSession({ id: '1', title: 'My Session' })]
    mockSessions.list.mockResolvedValue(sessions)
    render(<SessionDashboard />)

    await waitFor(() => {
      expect(screen.getByText('My Session')).toBeInTheDocument()
    })

    await user.click(screen.getByLabelText('Sitzungsoptionen'))
    await user.click(screen.getByText('Umbenennen'))

    expect(screen.getByText('Sitzung umbenennen')).toBeInTheDocument()
  })
})
