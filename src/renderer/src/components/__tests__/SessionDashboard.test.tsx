import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { groupSessionsByTime } from '../../utils/groupSessionsByTime'
import SessionDashboard from '../SessionDashboard'
import type { Session } from '../../../../shared/types'
import { createMockApi, emitApiEvent } from '../../test/mockApi'
import { renderWithProviders } from '../../test/renderWithProviders'

const render = renderWithProviders

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
    alignedTranscriptPath: null,
    pdfPath: null,
    extractedPath: null,
    entityMap: null,
    errorMessage: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
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

  // SessionDashboard übergibt das "Heute" aus useStartOfToday, damit Gruppen
  // und Karten-Zeitstempel denselben Tag zugrunde legen.
  it('gruppiert relativ zum übergebenen Zeitpunkt', () => {
    const session = makeSession({ createdAt: new Date(2026, 9, 11, 23, 10).toISOString() })

    expect(groupSessionsByTime([session], new Date(2026, 9, 11)).get('Heute')).toHaveLength(1)
    expect(groupSessionsByTime([session], new Date(2026, 9, 12)).get('Gestern')).toHaveLength(1)
  })
})

const mockSessions = {
  list: vi.fn(),
  delete: vi.fn(),
  rename: vi.fn()
}

beforeEach(() => {
  vi.clearAllMocks()
  window.api = createMockApi({ sessions: mockSessions })
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
      expect(screen.getByText('Keine Transkriptionen')).toBeInTheDocument()
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

    await user.click(screen.getByLabelText('Transkription löschen'))

    expect(screen.getByText('Transkription löschen')).toBeInTheDocument()
  })

  // Issue #202, AK 3: the list names what exists for this session
  it('lists exactly the data of this session in the delete dialog', async () => {
    const user = userEvent.setup()
    const sessions = [
      makeSession({
        id: '1',
        title: 'Meine Sitzung',
        audioPath: null,
        transcriptPath: '/t.json',
        anonymizedPath: '/a.json',
        summary: 'Zusammenfassung'
      })
    ]
    mockSessions.list.mockResolvedValue(sessions)
    render(<SessionDashboard />)

    await waitFor(() => {
      expect(screen.getByText('Meine Sitzung')).toBeInTheDocument()
    })
    await user.click(screen.getByLabelText('Transkription löschen'))

    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('«Meine Sitzung» und alle zugehörigen Daten')
    const items = within(dialog)
      .getAllByRole('listitem')
      .map((li) => li.textContent)
    expect(items).toEqual([
      'Transkript inklusive Ihrer Bearbeitungen',
      'Pseudonymisierung samt den Originaltexten aller Platzhalter',
      'Zwischenergebnisse der Verarbeitung',
      'Titel und Zusammenfassung'
    ])
  })

  // Epic #192: die Liste lädt nach jeder Änderung im Main-Prozess selbst nach
  it('lädt nach sessions:changed neu, ohne Refresh-Trigger von aussen', async () => {
    mockSessions.list.mockResolvedValue([])
    render(<SessionDashboard />)
    await screen.findByText('Keine Transkriptionen')

    mockSessions.list.mockResolvedValue([makeSession({ id: '1', title: 'Neue Sitzung' })])
    act(() => emitApiEvent(window.api, 'sessions.onChanged', { deletedIds: [] }))

    expect(await screen.findByText('Neue Sitzung')).toBeInTheDocument()
  })

  it('bündelt einen Sturm von Änderungen zu höchstens einer nachgeschobenen Abfrage', async () => {
    let resolveFirst: (value: Session[]) => void = () => {}
    mockSessions.list.mockReturnValueOnce(
      new Promise<Session[]>((resolve) => {
        resolveFirst = resolve
      })
    )
    mockSessions.list.mockResolvedValue([])
    render(<SessionDashboard />)
    await waitFor(() => expect(mockSessions.list).toHaveBeenCalled())
    const callsAfterMount = mockSessions.list.mock.calls.length

    act(() => {
      for (let i = 0; i < 5; i++) emitApiEvent(window.api, 'sessions.onChanged', { deletedIds: [] })
    })
    await act(async () => resolveFirst([]))

    await screen.findByText('Keine Transkriptionen')
    expect(mockSessions.list.mock.calls.length).toBe(callsAfterMount + 1)
  })

  it('importiert per Ziehen und Ablegen nur PDF-Dateien', async () => {
    mockSessions.list.mockResolvedValue([])
    window.api.import.getPathForFile = vi.fn((file: File) => `/tmp/${file.name}`)
    render(<SessionDashboard />)
    const empty = await screen.findByText('Keine Transkriptionen')

    const files = [
      new File(['%PDF'], 'bericht.pdf', { type: 'application/pdf' }),
      new File(['x'], 'notiz.txt', { type: 'text/plain' })
    ]
    fireEvent.drop(empty, { dataTransfer: { files } })

    await waitFor(() => expect(window.api.import.pdf).toHaveBeenCalledWith(['/tmp/bericht.pdf']))
  })
})

describe('SessionDashboard — Patientendossiers (#205)', () => {
  const hofer = {
    id: 'd1',
    firstName: 'Lukas',
    lastName: 'Hofer',
    externalId: 'PD-1188',
    birthDate: '1978-02-03'
  }

  it('shows the dossiers of each card and «Dossier zuordnen» without one (AK 4/5)', async () => {
    window.api = createMockApi({
      sessions: {
        list: vi.fn().mockResolvedValue([
          { ...makeSession({ id: 'a', title: 'Mit Dossier' }), dossiers: [hofer] },
          { ...makeSession({ id: 'b', title: 'Ohne Dossier' }), dossiers: [] }
        ])
      }
    })
    render(<SessionDashboard />)
    const withDossier = (await screen.findByText('Mit Dossier')).closest('[data-session-id]')!
    expect(within(withDossier as HTMLElement).getByText('Hofer, Lukas')).toBeInTheDocument()
    const without = screen.getByText('Ohne Dossier').closest('[data-session-id]')!
    expect(
      within(without as HTMLElement).getByRole('button', { name: 'Dossier zuordnen' })
    ).toBeInTheDocument()
  })

  it('offers assignment on a card in every state, also while processing (AK 3)', async () => {
    window.api = createMockApi({
      sessions: {
        list: vi.fn().mockResolvedValue([
          { ...makeSession({ id: 'p', title: 'Läuft', status: 'processing' }), dossiers: [] },
          { ...makeSession({ id: 'e', title: 'Kaputt', status: 'error' }), dossiers: [] }
        ])
      }
    })
    render(<SessionDashboard />)
    await screen.findByText('Läuft')
    expect(screen.getAllByRole('button', { name: 'Dossier zuordnen' })).toHaveLength(2)
  })

  it('reloads when a dossier changes — the badges show its name (AK 5)', async () => {
    const list = vi.fn().mockResolvedValue([])
    window.api = createMockApi({ sessions: { list } })
    render(<SessionDashboard />)
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1))
    await act(async () => emitApiEvent(window.api, 'dossiers.onChanged', { deletedIds: [] }))
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
  })

  it('names the dossiers the session disappears from in the delete dialog (AK 23)', async () => {
    const user = userEvent.setup()
    window.api = createMockApi({
      sessions: {
        list: vi.fn().mockResolvedValue([
          {
            ...makeSession({ id: 'a', title: 'Paargespräch' }),
            dossiers: [hofer, { ...hofer, id: 'd2', firstName: 'Maria', externalId: null }]
          }
        ])
      }
    })
    render(<SessionDashboard />)
    await screen.findByText('Paargespräch')
    await user.click(screen.getByRole('button', { name: 'Transkription löschen' }))
    const dialog = screen.getByRole('dialog', { name: 'Transkription löschen' })
    expect(within(dialog).getByText('Verschwindet aus den Patientendossiers:')).toBeInTheDocument()
    expect(within(dialog).getByText('Hofer, Lukas (PD-1188 · 03.02.1978)')).toBeInTheDocument()
    expect(within(dialog).getByText('Hofer, Maria (03.02.1978)')).toBeInTheDocument()
  })

  it('uses the singular for exactly one dossier', async () => {
    const user = userEvent.setup()
    window.api = createMockApi({
      sessions: {
        list: vi
          .fn()
          .mockResolvedValue([{ ...makeSession({ id: 'a', title: 'Einzeln' }), dossiers: [hofer] }])
      }
    })
    render(<SessionDashboard />)
    await screen.findByText('Einzeln')
    await user.click(screen.getByRole('button', { name: 'Transkription löschen' }))
    expect(screen.getByText('Verschwindet aus dem Patientendossier:')).toBeInTheDocument()
    expect(screen.queryByText('Verschwindet aus den Patientendossiers:')).not.toBeInTheDocument()
  })

  it('omits the section for a session without dossier (AK 23)', async () => {
    const user = userEvent.setup()
    window.api = createMockApi({
      sessions: {
        list: vi
          .fn()
          .mockResolvedValue([{ ...makeSession({ id: 'a', title: 'Allein' }), dossiers: [] }])
      }
    })
    render(<SessionDashboard />)
    await screen.findByText('Allein')
    await user.click(screen.getByRole('button', { name: 'Transkription löschen' }))
    expect(screen.queryByText('Verschwindet aus den Patientendossiers:')).not.toBeInTheDocument()
  })

  it('shows the document date on PDF cards without changing the order (AK 20, OOS 4)', async () => {
    const older = new Date(Date.now() - 2 * 86_400_000).toISOString()
    window.api = createMockApi({
      sessions: {
        list: vi.fn().mockResolvedValue([
          {
            ...makeSession({ id: 'new', title: 'Neu importiert', type: 'pdf' }),
            documentDate: '2020-01-01',
            dossiers: []
          },
          { ...makeSession({ id: 'old', title: 'Älter', createdAt: older }), dossiers: [] }
        ])
      }
    })
    render(<SessionDashboard />)
    await screen.findByText('Neu importiert')
    expect(
      screen.getByRole('button', { name: 'Dokumentdatum 01.01.2020 ändern' })
    ).toBeInTheDocument()
    const ids = Array.from(document.querySelectorAll('[data-session-id]')).map((el) =>
      el.getAttribute('data-session-id')
    )
    expect(ids).toEqual(['new', 'old'])
    expect(screen.getByRole('heading', { name: 'Heute' })).toBeInTheDocument()
  })
})
