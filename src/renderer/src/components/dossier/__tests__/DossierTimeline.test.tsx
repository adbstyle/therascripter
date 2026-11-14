import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { DossierTimeline } from '../DossierTimeline'
import { TimelineEntryCard } from '../TimelineEntryCard'
import { createMockApi, emitApiEvent } from '../../../test/mockApi'
import {
  makeDossierListItem,
  makeDossierRef,
  makeTimelineEntry
} from '../../../test/dossierFixtures'
import { ToastProvider } from '../../../contexts/ToastContext'
import { NavigationProvider } from '../../../navigation/NavigationContext'
import { useNavigation } from '../../../navigation/navigation'
import { RecordingContext, type RecordingState } from '../../../contexts/recording'
import { WorkspaceActionsContext, type WorkspaceActions } from '../../../contexts/workspaceActions'
import { PageScroll } from '../../shell/PageScroll'
import { createValueStore } from '../../../utils/valueStore'
import { getViewModeStore, _resetViewModeStoreForTests } from '../../../viewMode/viewModeStore'
import type { TimelineEntry } from '../../../../../shared/types/Dossier'

function recordingState(overrides: Partial<RecordingState> = {}): RecordingState {
  return {
    isRecording: false,
    sessionId: null,
    recordingDossierId: null,
    level: createValueStore(0),
    duration: createValueStore(65),
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    microphone: {} as RecordingState['microphone'],
    consentDismissed: false,
    dismissConsent: vi.fn(),
    ...overrides
  }
}

function RouteProbe(): React.JSX.Element {
  const { route, anchorId, back } = useNavigation()
  return (
    <div>
      <span data-testid="route">
        {route.kind === 'session' ? `session:${route.sessionId}` : route.kind}
      </span>
      <span data-testid="anchor">{anchorId ?? ''}</span>
      <button type="button" onClick={() => back()}>
        Probe zurück
      </button>
    </div>
  )
}

function renderTimeline(
  entries: TimelineEntry[] | (() => Promise<TimelineEntry[]>),
  options: {
    recording?: RecordingState
    anchorId?: string
    probe?: boolean
    workspace?: Partial<WorkspaceActions>
  } = {}
) {
  const workspace: WorkspaceActions = {
    startRecording: vi.fn().mockResolvedValue(undefined),
    importPdfs: vi.fn().mockResolvedValue(undefined),
    isImporting: false,
    openNewDossier: vi.fn(),
    ...options.workspace
  }
  const timeline =
    typeof entries === 'function' ? vi.fn(entries) : vi.fn().mockResolvedValue(entries)
  window.api = createMockApi({ dossiers: { timeline } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ToastProvider>
      <NavigationProvider initialRoute={{ kind: 'dossier', dossierId: 'd1' }}>
        <RecordingContext.Provider value={options.recording ?? recordingState()}>
          <WorkspaceActionsContext.Provider value={workspace}>
            <PageScroll entryId={1} anchorId={options.anchorId} positions={new Map()}>
              {children}
              {options.probe && <RouteProbe />}
            </PageScroll>
          </WorkspaceActionsContext.Provider>
        </RecordingContext.Provider>
      </NavigationProvider>
    </ToastProvider>
  )
  const view = render(<DossierTimeline dossierId="d1" dossierName="Hofer, Lukas" />, { wrapper })
  return { ...view, timeline, workspace, user: userEvent.setup() }
}

beforeEach(() => {
  _resetViewModeStoreForTests()
})
afterEach(() => {
  _resetViewModeStoreForTests()
})

describe('DossierTimeline (#205)', () => {
  it('explains recording, import and assigning when the dossier is empty (AK 17, #206)', async () => {
    const { user } = renderTimeline([], { probe: true })
    expect(await screen.findByText('Noch keine Sitzungen oder PDF-Dokumente')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Starten Sie oben eine Aufnahme oder importieren Sie ein PDF – oder ziehen Sie ein PDF hierher. Bestehende Transkriptionen ordnen Sie in der Liste «Transkriptionen» über «Dossier zuordnen» zu.'
      )
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Zu den Transkriptionen' }))
    expect(screen.getByTestId('route')).toHaveTextContent('sessions')
  })

  it('imports PDFs dropped onto the timeline into this dossier (#206)', async () => {
    const { workspace } = renderTimeline([])
    await screen.findByText('Noch keine Sitzungen oder PDF-Dokumente')
    window.api.import.getPathForFile = vi.fn((file: File) => `/tmp/${file.name}`)
    const section = screen.getByRole('region', { name: 'Verlauf' })
    const files = [
      new File(['%PDF'], 'bericht.pdf', { type: 'application/pdf' }),
      new File(['x'], 'notiz.txt', { type: 'text/plain' })
    ]
    fireEvent.dragOver(section, { dataTransfer: { files } })
    expect(screen.getByText('Es wird diesem Patientendossier zugeordnet.')).toBeInTheDocument()
    fireEvent.drop(section, { dataTransfer: { files } })
    await waitFor(() =>
      expect(workspace.importPdfs).toHaveBeenCalledWith(['/tmp/bericht.pdf'], {
        dossierId: 'd1',
        dossierName: 'Hofer, Lukas'
      })
    )
    expect(screen.queryByText('Es wird diesem Patientendossier zugeordnet.')).toBeNull()
  })

  it('groups the entries by month in the order of the main process (AK 6)', async () => {
    renderTimeline([
      makeTimelineEntry({ id: 'a', title: 'Rückfall', sortDay: '2026-11-06' }),
      makeTimelineEntry({
        id: 'b',
        title: 'Austrittsbericht',
        type: 'pdf',
        documentDate: '2026-11-02',
        sortDay: '2026-11-02'
      }),
      makeTimelineEntry({ id: 'c', title: 'Paargespräch', sortDay: '2026-10-30' })
    ])
    await screen.findByRole('heading', { name: 'November 2026' })
    // Flache Folge: Monatskopf, dann seine Einträge (Karten bleiben beim Monatswechsel erhalten)
    const sequence = Array.from(screen.getByRole('region', { name: 'Verlauf' }).children).map(
      (el) => (el.tagName === 'H2' ? el.textContent : el.getAttribute('data-session-id'))
    )
    expect(sequence).toEqual(['November 2026', 'a', 'b', 'Oktober 2026', 'c'])
  })

  it('keeps the card and its focus when a new document date moves it to another month', async () => {
    let documentDate = '2026-11-02'
    const pdf = () =>
      makeTimelineEntry({
        id: 'p',
        title: 'Bericht',
        type: 'pdf',
        documentDate,
        sortDay: documentDate
      })
    renderTimeline(async () => [
      makeTimelineEntry({ id: 'a', title: 'Rückfall', sortDay: '2026-11-06' }),
      pdf()
    ])
    const button = await screen.findByRole('button', { name: 'Dokumentdatum 02.11.2026 ändern' })
    const card = button.closest('article')!
    button.focus()
    documentDate = '2026-10-15'
    await act(async () => emitApiEvent(window.api, 'sessions.onChanged', { deletedIds: [] }))
    await screen.findByRole('heading', { name: 'Oktober 2026' })
    expect(document.querySelector('[data-session-id="p"]')).toBe(card)
    expect(document.activeElement).toBe(button)
  })

  it('locks «Erneut versuchen» while any session is processing — same source as the list', async () => {
    window.api = createMockApi()
    const timeline = vi
      .fn()
      .mockResolvedValue([makeTimelineEntry({ id: 'f', status: 'error', errorMessage: 'Kaputt' })])
    window.api = createMockApi({
      dossiers: { timeline },
      sessions: {
        list: vi
          .fn()
          .mockResolvedValue([
            { ...makeTimelineEntry({ id: 'other', status: 'processing' }), dossiers: [] }
          ])
      }
    })
    render(<DossierTimeline dossierId="d1" />, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <ToastProvider>
          <NavigationProvider initialRoute={{ kind: 'dossier', dossierId: 'd1' }}>
            <RecordingContext.Provider value={recordingState()}>
              <WorkspaceActionsContext.Provider
                value={{
                  startRecording: vi.fn(),
                  importPdfs: vi.fn(),
                  isImporting: false,
                  openNewDossier: vi.fn()
                }}
              >
                {children}
              </WorkspaceActionsContext.Provider>
            </RecordingContext.Provider>
          </NavigationProvider>
        </ToastProvider>
      )
    })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Erneut versuchen' })).toBeDisabled()
    )
  })

  it('keeps an entry and its selection while the user unassigns this dossier', async () => {
    let assigned = [makeDossierRef(), makeDossierRef({ id: 'd2', firstName: 'Maria' })]
    const { user } = renderTimeline(async () =>
      assigned.some((d) => d.id === 'd1')
        ? [makeTimelineEntry({ id: 'e1', title: 'Paargespräch', dossiers: assigned })]
        : []
    )
    window.api.dossiers.list = vi
      .fn()
      .mockResolvedValue([
        makeDossierListItem(),
        makeDossierListItem({ id: 'd2', firstName: 'Maria' })
      ])
    window.api.dossiers.unassign = vi.fn(async (_s: string, d: string) => {
      assigned = assigned.filter((x) => x.id !== d)
      emitApiEvent(window.api, 'sessions.onChanged', { deletedIds: [] })
      return { ok: true as const }
    })
    await user.click(await screen.findByRole('button', { name: /Auch in Hofer, Maria/ }))
    // die letzte «Auch in»-Zuordnung lösen: Auswahl bleibt offen und umkehrbar
    await user.click(await screen.findByRole('checkbox', { name: /Hofer, Maria/ }))
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: /Hofer, Maria/ })).not.toBeChecked()
    )
    // jetzt das Dossier dieser Seite lösen: Eintrag bleibt, bis die Auswahl schliesst
    await user.click(screen.getByRole('checkbox', { name: /Hofer, Lukas/ }))
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: /Hofer, Lukas/ })).not.toBeChecked()
    )
    expect(screen.getByText('Paargespräch')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Fertig' }))
    expect(await screen.findByText('Noch keine Sitzungen oder PDF-Dokumente')).toBeInTheDocument()
  })

  it('opens a processed entry and finds the place again after closing (AK 15/16)', async () => {
    const { user } = renderTimeline([makeTimelineEntry({ id: 'e1', title: 'Erstgespräch' })], {
      probe: true
    })
    await user.click(await screen.findByRole('button', { name: 'Erstgespräch öffnen' }))
    expect(screen.getByTestId('route')).toHaveTextContent('session:e1')
    await user.click(screen.getByRole('button', { name: 'Probe zurück' }))
    // Der Herkunftseintrag trägt den Anker, über den useScrollRestoration die Karte findet
    expect(screen.getByTestId('anchor')).toHaveTextContent('e1')
  })

  it('highlights the entry it came back to (AK 16)', async () => {
    renderTimeline(
      [makeTimelineEntry({ id: 'e1' }), makeTimelineEntry({ id: 'e2', title: 'Zweite' })],
      { anchorId: 'e2' }
    )
    await screen.findByText('Zweite')
    await waitFor(() =>
      expect(
        document.querySelector('[data-session-id="e2"]')?.classList.contains('session-highlight')
      ).toBe(true)
    )
  })

  it('reloads on sessions:changed and dossiers:changed — always the current state (AK 14)', async () => {
    let title = 'Alter Titel'
    const { timeline } = renderTimeline(async () => [
      makeTimelineEntry({ id: 'e1', title, titlePlain: title })
    ])
    await screen.findByText('Alter Titel')
    title = 'Neuer Titel'
    await act(async () => emitApiEvent(window.api, 'sessions.onChanged', { deletedIds: [] }))
    expect(await screen.findByText('Neuer Titel')).toBeInTheDocument()
    await act(async () => emitApiEvent(window.api, 'dossiers.onChanged', { deletedIds: [] }))
    await waitFor(() => expect(timeline).toHaveBeenCalledTimes(3))
  })

  it('shows the running recording as live card (AK 12)', async () => {
    renderTimeline(
      [makeTimelineEntry({ id: 'rec', title: 'Aufnahme 14.11.2026', status: 'recording' })],
      { recording: recordingState({ isRecording: true, sessionId: 'rec' }) }
    )
    expect(await screen.findByRole('button', { name: 'Aufnahme stoppen' })).toBeInTheDocument()
    expect(screen.getByLabelText(/^Aufnahmedauer /)).toBeInTheDocument()
  })

  // Lastunabhängig (Abschluss-Check #192): jsdom unter CPU-Last streckt jede
  // absolute Zeit. Die Aussage «linear, keine Arbeit pro Eintrag im Quadrat»
  // prüft das Verhältnis zu 30 Einträgen, gemessen unmittelbar davor im selben
  // Prozess; die absolute Grenze fängt nur grobe Rückschritte (auf dem
  // Entwicklungs-Mac ~0.3 s für 300 Einträge). AK 25 selbst (< 1 s auf einem
  // 8-GB-Mac) ist nur in der laufenden App messbar.
  it('renders 300 entries in well under a second (AK 25)', async () => {
    const makeEntries = (count: number): TimelineEntry[] =>
      Array.from({ length: count }, (_, i) => {
        const day = new Date(2026, 10, 14 - Math.floor(i / 2))
        const iso = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
        return makeTimelineEntry({
          id: `e${i}`,
          title: `Sitzung ${i}`,
          titlePlain: `Sitzung ${i}`,
          type: i % 3 === 0 ? 'pdf' : 'audio',
          summary: 'Zusammenfassung '.repeat(30),
          summaryPlain: 'Zusammenfassung '.repeat(30),
          sortDay: iso,
          dossiers: [makeDossierRef(), makeDossierRef({ id: 'd2', firstName: 'Maria' })]
        })
      })
    const timed = async (count: number): Promise<number> => {
      const start = performance.now()
      const view = renderTimeline(makeEntries(count))
      await screen.findByText(`Sitzung ${count - 1}`)
      const elapsed = performance.now() - start
      expect(screen.getAllByRole('article')).toHaveLength(count)
      view.unmount()
      return elapsed
    }
    await timed(30) // Aufwärmen (Module, erste Darstellung)
    const small = await timed(30)
    const large = await timed(300)
    console.log(
      `[DossierTimeline] 30 Einträge ${small.toFixed(0)} ms, 300 Einträge ${large.toFixed(0)} ms`
    )
    expect(large).toBeLessThan(Math.max(25 * small, 250))
    expect(large).toBeLessThan(10_000)
  }, 60_000)
})

describe('TimelineEntryCard (#205 AK 10–15)', () => {
  function renderCard(entry: TimelineEntry, onOpen = vi.fn(), onRetry?: () => void) {
    window.api = createMockApi()
    render(
      <ToastProvider>
        <TimelineEntryCard entry={entry} dossierId="d1" onOpen={onOpen} onRetry={onRetry} />
      </ToastProvider>
    )
    return { onOpen, user: userEvent.setup() }
  }

  it('shows kind, date, title and summary of a session (AK 10)', () => {
    renderCard(makeTimelineEntry({ title: 'Rückfall nach Stellenwechsel' }))
    expect(screen.getByRole('img', { name: 'Sitzung' })).toBeInTheDocument()
    expect(screen.getByText('Rückfall nach Stellenwechsel')).toBeInTheDocument()
    expect(screen.getByText('Klient berichtet über Schlafprobleme.')).toBeInTheDocument()
    expect(screen.getByText(/^\d{2}\.\d{2}\.\d{2}|Gestern|\d{2}:\d{2}/)).toBeInTheDocument()
  })

  it('shows a PDF with its document date or «· Importdatum» (AK 10/20)', () => {
    renderCard(
      makeTimelineEntry({
        type: 'pdf',
        createdAt: '2026-10-21T09:00:00.000Z',
        documentDate: null,
        sortDay: '2026-10-21'
      })
    )
    expect(screen.getByRole('img', { name: 'PDF-Dokument' })).toBeInTheDocument()
    expect(screen.getByText('21.10.2026 · Importdatum')).toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: 'Dokumentdatum festlegen, es gilt das Importdatum 21.10.2026'
      })
    ).toBeInTheDocument()
  })

  it('marks a processed entry without summary (AK 11)', () => {
    renderCard(makeTimelineEntry({ summary: null, summaryPlain: null }))
    expect(screen.getByText('Keine Zusammenfassung')).toBeInTheDocument()
  })

  it('shows processing, waiting and failed entries without opening them (AK 12/15)', async () => {
    const { onOpen } = renderCard(
      makeTimelineEntry({ status: 'error', errorMessage: 'Verarbeitung reagiert nicht mehr.' }),
      vi.fn(),
      vi.fn()
    )
    expect(screen.getByText('Fehler')).toBeInTheDocument()
    expect(screen.getByText('Verarbeitung reagiert nicht mehr.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Erneut versuchen' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /öffnen$/ })).not.toBeInTheDocument()
    expect(screen.queryByText('Keine Zusammenfassung')).not.toBeInTheDocument()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('shows a waiting entry as such', () => {
    renderCard(makeTimelineEntry({ status: 'queued', summary: null, summaryPlain: null }))
    expect(screen.getByText('Wartet')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /öffnen$/ })).not.toBeInTheDocument()
  })

  it('shows an entry in processing as such', () => {
    renderCard(makeTimelineEntry({ status: 'processing', summary: null, summaryPlain: null }))
    expect(screen.getByText('Verarbeitung')).toBeInTheDocument()
    expect(screen.queryByText('Keine Zusammenfassung')).not.toBeInTheDocument()
  })

  it('opens a processed entry (AK 15)', async () => {
    const { onOpen, user } = renderCard(makeTimelineEntry({ id: 'e9', title: 'Erstgespräch' }))
    await user.click(screen.getByRole('button', { name: 'Erstgespräch öffnen' }))
    expect(onOpen).toHaveBeenCalledWith('e9')
  })

  it('shows title and summary in the chosen view (AK 13)', () => {
    getViewModeStore().set('pseudonymized')
    const entry = makeTimelineEntry({
      title: 'Gespräch mit [PERSON 1]',
      titlePlain: 'Gespräch mit Ruth Gerber',
      summary: '[PERSON 1] erzählt.',
      summaryPlain: 'Ruth Gerber erzählt.'
    })
    renderCard(entry)
    expect(screen.getByText('Gespräch mit [PERSON 1]')).toBeInTheDocument()
    act(() => getViewModeStore().set('plain'))
    expect(screen.getByText('Gespräch mit Ruth Gerber')).toBeInTheDocument()
    expect(screen.getByText('Ruth Gerber erzählt.')).toBeInTheDocument()
  })

  it('lists the other dossiers as «Auch in» (AK 7)', () => {
    renderCard(
      makeTimelineEntry({
        dossiers: [makeDossierRef(), makeDossierRef({ id: 'd2', firstName: 'Maria' })]
      })
    )
    expect(screen.getByText('Auch in: Hofer, Maria')).toBeInTheDocument()
    expect(screen.queryByText('Auch in: Hofer, Lukas')).not.toBeInTheDocument()
  })
})
