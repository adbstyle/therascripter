import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { DossierTimeline } from '../DossierTimeline'
import { TimelineEntryCard } from '../TimelineEntryCard'
import { createMockApi, emitApiEvent } from '../../../test/mockApi'
import { makeDossierRef, makeTimelineEntry } from '../../../test/dossierFixtures'
import { ToastProvider } from '../../../contexts/ToastContext'
import { NavigationProvider } from '../../../navigation/NavigationContext'
import { useNavigation } from '../../../navigation/navigation'
import { RecordingContext, type RecordingState } from '../../../contexts/recording'
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
  options: { recording?: RecordingState; anchorId?: string; probe?: boolean } = {}
) {
  const timeline =
    typeof entries === 'function' ? vi.fn(entries) : vi.fn().mockResolvedValue(entries)
  window.api = createMockApi({ dossiers: { timeline } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ToastProvider>
      <NavigationProvider initialRoute={{ kind: 'dossier', dossierId: 'd1' }}>
        <RecordingContext.Provider value={options.recording ?? recordingState()}>
          <PageScroll entryId={1} anchorId={options.anchorId} positions={new Map()}>
            {children}
            {options.probe && <RouteProbe />}
          </PageScroll>
        </RecordingContext.Provider>
      </NavigationProvider>
    </ToastProvider>
  )
  const view = render(<DossierTimeline dossierId="d1" />, { wrapper })
  return { ...view, timeline, user: userEvent.setup() }
}

beforeEach(() => {
  _resetViewModeStoreForTests()
})
afterEach(() => {
  _resetViewModeStoreForTests()
})

describe('DossierTimeline (#205)', () => {
  it('explains how to assign when the dossier is empty (AK 17)', async () => {
    const { user } = renderTimeline([], { probe: true })
    expect(await screen.findByText('Noch keine Sitzungen oder PDF-Dokumente')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Ordnen Sie bestehende Transkriptionen in der Liste «Transkriptionen» über «Dossier zuordnen» diesem Patientendossier zu.'
      )
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Zu den Transkriptionen' }))
    expect(screen.getByTestId('route')).toHaveTextContent('sessions')
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
    const november = (await screen.findByRole('heading', { name: 'November 2026' })).parentElement!
    expect(
      within(november)
        .getAllByRole('article')
        .map((a) => a.getAttribute('data-session-id'))
    ).toEqual(['a', 'b'])
    const october = screen.getByRole('heading', { name: 'Oktober 2026' }).parentElement!
    expect(within(october).getByText('Paargespräch')).toBeInTheDocument()
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

  it('renders 300 entries in well under a second (AK 25)', async () => {
    const entries = Array.from({ length: 300 }, (_, i) => {
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
    const start = performance.now()
    renderTimeline(entries)
    await screen.findByText('Sitzung 299')
    const elapsed = performance.now() - start
    expect(screen.getAllByRole('article')).toHaveLength(300)
    // jsdom ist deutlich langsamer als Chromium; das Budget gilt für den Test-Rechner
    expect(elapsed).toBeLessThan(1000)
  })
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
