import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import {
  act,
  configure,
  fireEvent,
  getConfig,
  screen,
  waitFor,
  within
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SearchHost } from '../SearchHost'
import { renderWithProviders } from '../../../test/renderWithProviders'
import { createMockApi, emitApiEvent } from '../../../test/mockApi'
import { useNavigation } from '../../../navigation/navigation'
import { _resetSearchSessionForTests, openSearchModal } from '../../../stores/searchSession'
import { searchRowRenders } from '../searchOptions'
import { SEARCH_DEBOUNCE_MS } from '../../../hooks/useSearch'
import { _resetViewModeStoreForTests, setViewMode } from '../../../viewMode/viewModeStore'
import type { SearchAvailability, SearchQueryInput } from '../../../../../shared/types/Search'
import {
  answer,
  deferred,
  doc,
  DOSSIER_HOFER_LUKAS,
  DOSSIER_HOFER_LUKAS_2,
  exactHit,
  semanticHit
} from './searchFixtures'

/**
 * #209 — Suchfenster: Zustände, zweistufige Antwort, Tastatur, Rücksprung
 * (`reopenOverlay`, AK 12), gelöschte Treffer, Zugänglichkeit.
 */

function RouteProbe(): React.JSX.Element {
  const { route, back } = useNavigation()
  return (
    <div>
      <p data-testid="route">{JSON.stringify(route)}</p>
      <button onClick={() => back()}>Zurück im Verlauf</button>
    </div>
  )
}

function renderHost() {
  return renderWithProviders(
    <>
      <RouteProbe />
      <SearchHost />
    </>
  )
}

const READY: SearchAvailability = { model: { status: 'ready' }, semantic: 'ready' }

function route(): unknown {
  return JSON.parse(screen.getByTestId('route').textContent ?? 'null')
}

async function openModal(): Promise<HTMLElement> {
  act(() => emitApiEvent(window.api, 'nav.onCommand', 'search'))
  return screen.findByRole('dialog', { name: 'Patientendossiers und Inhalte durchsuchen' })
}

async function typeQuery(text: string): Promise<void> {
  const input = screen.getByRole('combobox')
  fireEvent.change(input, { target: { value: text } })
}

// Lastunabhängig: Nach dem Tippen wartet die Oberfläche die Entprellung
// (SEARCH_DEBOUNCE_MS) echt ab. Unter Last kann das samt Rendern länger als
// die üblichen 1 s der find*-Abfragen dauern — die Frist ist deshalb
// grosszügig; am Ergebnis ändert sie nichts. Was VOR dem Ende der Entprellung
// geschehen muss, läuft mit Fake-Timern.
let asyncUtilTimeout: number
beforeAll(() => {
  asyncUtilTimeout = getConfig().asyncUtilTimeout
  configure({ asyncUtilTimeout: 10_000 })
})
afterAll(() => configure({ asyncUtilTimeout }))

beforeEach(() => {
  _resetSearchSessionForTests()
  _resetViewModeStoreForTests()
  window.api = createMockApi({
    search: {
      open: vi.fn().mockResolvedValue(READY),
      query: vi.fn().mockImplementation(async (input: SearchQueryInput) =>
        answer(input.requestId, {
          dossiers: [DOSSIER_HOFER_LUKAS, DOSSIER_HOFER_LUKAS_2],
          results: [doc('s1'), doc('s2', { type: 'pdf', hits: [exactHit({ label: {} })] })],
          semantic: 'pending'
        })
      ),
      semantic: vi.fn().mockImplementation(async (input: SearchQueryInput) =>
        answer(input.requestId, {
          dossiers: [DOSSIER_HOFER_LUKAS, DOSSIER_HOFER_LUKAS_2],
          results: [
            doc('s1'),
            doc('s2', { type: 'pdf', hits: [exactHit({ label: {} })] }),
            doc('s3', { hits: [semanticHit()] })
          ],
          semantic: 'complete'
        })
      )
    }
  })
})

afterEach(() => {
  _resetSearchSessionForTests()
})

describe('Suchfenster öffnen und schliessen', () => {
  it('⌘K (nav:command search) öffnet es, lädt vor und schaltet um', async () => {
    renderHost()
    const dialog = await openModal()
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(window.api.search.open).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('combobox')).toHaveFocus()
    act(() => emitApiEvent(window.api, 'nav.onCommand', 'search'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Suchfeld: zugänglicher Name ohne Tastaturhinweis, Bereich «Alle Inhalte» bleibt sichtbar (#211 AK 2)', async () => {
    renderHost()
    await openModal()
    const input = screen.getByRole('combobox', { name: 'In allen Inhalten suchen' })
    expect(input).toHaveAccessibleName('In allen Inhalten suchen')
    expect(screen.getByTestId('search-scope')).toHaveTextContent('Alle Inhalte')
    await typeQuery('Hofer')
    await screen.findAllByText('Hofer, Lukas')
    expect(screen.getByTestId('search-scope')).toBeVisible()
    expect(screen.getByTestId('search-scope')).toHaveTextContent('Alle Inhalte')
  })

  it('Esc schliesst nur das Fenster und erreicht keine Esc-Handler darunter', async () => {
    renderHost()
    // Wie der Editor: ein Esc-Handler am window, der vorbehandelte Esc auslässt
    const below = vi.fn()
    const windowHandler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented) below()
    }
    window.addEventListener('keydown', windowHandler)
    await openModal()
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(below).not.toHaveBeenCalled()
    window.removeEventListener('keydown', windowHandler)
  })

  it('holt eine getippte, aber noch nicht gesuchte Anfrage beim nächsten Öffnen nach', async () => {
    renderHost()
    await openModal()
    // Nur zwischen Tippen und Schliessen falsche Timer: Schliessen vor dem Ende
    // der Entprellung gelingt so unabhängig von der Rechnerlast. (find*/waitFor
    // von Testing Library warten intern auf setTimeout — nicht während der
    // falschen Timer aufrufen.)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await typeQuery('Hofer')
      act(() => {
        vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1)
      })
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' })
      expect(window.api.search.query).not.toHaveBeenCalled()
      // Das Schliessen hat die Entprellung beendet: auch später keine Anfrage
      act(() => {
        vi.advanceTimersByTime(10 * SEARCH_DEBOUNCE_MS)
      })
      expect(window.api.search.query).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
    await openModal()
    expect(screen.getByRole('combobox')).toHaveValue('Hofer')
    await waitFor(() =>
      expect(window.api.search.query).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'Hofer' })
      )
    )
  })

  it('öffnet sich nicht über einem anderen Dialog', async () => {
    renderHost()
    const other = document.createElement('div')
    other.setAttribute('role', 'dialog')
    other.setAttribute('aria-modal', 'true')
    document.body.appendChild(other)
    act(() => openSearchModal())
    expect(screen.queryByRole('dialog', { name: /durchsuchen/ })).toBeNull()
    other.remove()
  })
})

describe('Leerzustand: letzte Suchen (#209 AK 27/28)', () => {
  it('zeigt die letzten Suchanfragen, führt eine erneut aus und merkt sie', async () => {
    vi.mocked(window.api.search.recentList).mockResolvedValue([
      { query: 'Schlafprobleme', usedAt: '2026-11-14T08:00:00.000Z' },
      { query: 'Hofer', usedAt: '2026-11-13T08:00:00.000Z' }
    ])
    renderHost()
    await openModal()
    const list = await screen.findByRole('listbox', { name: 'Letzte Suchen' })
    const options = within(list).getAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual(['Schlafprobleme', 'Hofer'])
    await userEvent.click(options[1])
    expect(window.api.search.query).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'Hofer', scope: { kind: 'all' } })
    )
    expect(window.api.search.recentRemember).toHaveBeenCalledWith('Hofer')
    expect(screen.getByRole('combobox')).toHaveValue('Hofer')
  })

  it('«Verlauf löschen» leert die Liste', async () => {
    vi.mocked(window.api.search.recentList).mockResolvedValue([
      { query: 'Hofer', usedAt: '2026-11-13T08:00:00.000Z' }
    ])
    renderHost()
    await openModal()
    await userEvent.click(await screen.findByRole('button', { name: 'Verlauf löschen' }))
    expect(window.api.search.recentClear).toHaveBeenCalledTimes(1)
    expect(
      await screen.findByText(/Findet Patientendossiers über Name oder Dossier-ID/)
    ).toBeTruthy()
    expect(screen.queryByRole('option')).toBeNull()
  })
})

describe('Treffer in zwei Stufen', () => {
  it('zeigt Dossiers getrennt und vorn, Inhalte danach; Treffer nach Bedeutung kommen nach', async () => {
    const second = deferred<ReturnType<typeof answer>>()
    vi.mocked(window.api.search.semantic).mockImplementation(async (input) => {
      const result = await second.promise
      return { ...result, requestId: input.requestId }
    })
    renderHost()
    await openModal()
    await typeQuery('Hofer')

    const list = await screen.findByRole('listbox', { name: 'Treffer' })
    const dossiers = await within(list).findByRole('group', { name: 'Patientendossiers' })
    // Gleichnamige Dossiers unterscheidbar über ID · Geburtsdatum (AK 25)
    expect(within(dossiers).getByText('PD-1188 · 03.02.1978')).toBeTruthy()
    expect(within(dossiers).getByText('PD-2001 · 12.07.1990')).toBeTruthy()
    expect(screen.getByText('Sitzungen und PDF-Dokumente · 2 Treffer')).toBeTruthy()
    // Ladeanzeige nur für die Suche nach Bedeutung
    expect(screen.getByTestId('semantic-pending')).toBeTruthy()
    // Reihenfolge: Dossiers vor den Inhalten (AK 24)
    const all = within(list).getAllByRole('option')
    expect(all[0]).toHaveTextContent('Hofer, Lukas')
    expect(all[2]).toHaveTextContent('Sitzung s1')

    second.resolve(
      answer(0, {
        dossiers: [DOSSIER_HOFER_LUKAS, DOSSIER_HOFER_LUKAS_2],
        results: [doc('s3', { hits: [semanticHit()] }), doc('s1'), doc('s2')],
        semantic: 'complete'
      })
    )
    await waitFor(() => expect(screen.queryByTestId('semantic-pending')).toBeNull())
    // Ohne Arbeit an der Liste gilt die gerankte Reihenfolge
    const titles = within(list)
      .getAllByRole('group')
      .slice(1)
      .map((g) => g.getAttribute('aria-labelledby'))
    expect(titles).toHaveLength(3)
    expect(within(list).getAllByRole('option')[2]).toHaveTextContent('Sitzung s3')
  })

  it('hängt nachkommende Treffer unten an, sobald der USER die Liste benutzt (keine Sprünge)', async () => {
    const second = deferred<ReturnType<typeof answer>>()
    vi.mocked(window.api.search.semantic).mockImplementation(async (input) => ({
      ...(await second.promise),
      requestId: input.requestId
    }))
    renderHost()
    await openModal()
    await typeQuery('Hofer')
    await screen.findByText('Sitzungen und PDF-Dokumente · 2 Treffer')
    const input = screen.getByRole('combobox')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    const activeBefore = input.getAttribute('aria-activedescendant')
    const activeText = document.getElementById(activeBefore!)!.textContent

    second.resolve(
      answer(0, {
        dossiers: [DOSSIER_HOFER_LUKAS, DOSSIER_HOFER_LUKAS_2],
        results: [doc('s3', { hits: [semanticHit()] }), doc('s1'), doc('s2')],
        semantic: 'complete'
      })
    )
    await waitFor(() => expect(screen.queryByTestId('semantic-pending')).toBeNull())
    const options = screen.getAllByRole('option')
    expect(options[2]).toHaveTextContent('Sitzung s1')
    expect(options[options.length - 2]).toHaveTextContent('Sitzung s3')
    expect(document.getElementById(input.getAttribute('aria-activedescendant')!)!.textContent).toBe(
      activeText
    )
  })

  it('verwirft Antworten auf überholte Anfragen', async () => {
    const first = deferred<ReturnType<typeof answer>>()
    vi.mocked(window.api.search.query).mockImplementation(async (input) => {
      if (input.query === 'alt') return { ...(await first.promise), requestId: input.requestId }
      return answer(input.requestId, { results: [doc('neu')], semantic: 'model-missing' })
    })
    renderHost()
    await openModal()
    await typeQuery('alt')
    await waitFor(() => expect(window.api.search.query).toHaveBeenCalledTimes(1))
    await typeQuery('neu')
    await screen.findByText(/Sitzung neu/)
    first.resolve(answer(0, { results: [doc('alt')], semantic: 'model-missing' }))
    // Die überholte Antwort ist da und verarbeitet (Mikrotasks), bevor geprüft wird
    await act(async () => {
      await first.promise
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(screen.queryByText(/Sitzung alt/)).toBeNull()
    expect(screen.getByText(/Sitzung neu/)).toBeTruthy()
  })

  it('stösst eine abgelöste (superseded), aber noch aktuelle Suche nach Bedeutung einmal neu an', async () => {
    vi.mocked(window.api.search.semantic)
      .mockImplementationOnce(async (input) =>
        answer(input.requestId, { results: [doc('s1')], semantic: 'superseded' })
      )
      .mockImplementation(async (input) =>
        answer(input.requestId, { results: [doc('s1'), doc('s3')], semantic: 'complete' })
      )
    renderHost()
    await openModal()
    await typeQuery('Brändli')
    expect(await screen.findByText('[PERSON 1] Sitzung s3')).toBeTruthy()
    expect(window.api.search.semantic).toHaveBeenCalledTimes(2)
  })

  it('entprellt die Eingabe (eine Anfrage für schnelles Tippen)', async () => {
    renderHost()
    await openModal()
    for (const q of ['H', 'Ho', 'Hof', 'Hofe', 'Hofer']) await typeQuery(q)
    await screen.findByText('Sitzungen und PDF-Dokumente · 2 Treffer')
    expect(window.api.search.query).toHaveBeenCalledTimes(1)
    expect(vi.mocked(window.api.search.query).mock.calls[0][0].query).toBe('Hofer')
  })

  it('zeigt Titel in der gewählten Ansicht, Ausschnitte immer im Klartext mit Markierung', async () => {
    renderHost()
    await openModal()
    await typeQuery('Brändli')
    await screen.findByText('[PERSON 1] Sitzung s1')
    // Ausschnitt im Klartext, exakte Stelle markiert
    const marks = document.querySelectorAll('mark')
    expect(marks[0].textContent).toBe('Brändli')
    expect(screen.getByText('Dossiers über Name oder ID · Ausschnitte im Klartext')).toBeTruthy()
    act(() => setViewMode('plain'))
    expect(await screen.findByText('Lukas Hofer Sitzung s1')).toBeTruthy()
    // Stelle links: Sprecher · Zeit, PDF ohne Seitenlabel
    expect(screen.getAllByText('Person B · 00:14:32').length).toBeGreaterThan(0)
    expect(screen.getByText('Textstelle')).toBeTruthy()
  })

  it('meldet «Keine Treffer», sobald auch die Suche nach Bedeutung fertig ist (AK 10)', async () => {
    vi.mocked(window.api.search.query).mockImplementation(async (input) =>
      answer(input.requestId, { semantic: 'pending' })
    )
    vi.mocked(window.api.search.semantic).mockImplementation(async (input) =>
      answer(input.requestId, { semantic: 'complete' })
    )
    renderHost()
    await openModal()
    await typeQuery('Kündigung Mietwohnung')
    expect(
      (await screen.findAllByText('Keine Treffer für «Kündigung Mietwohnung»')).length
    ).toBeGreaterThan(0)
    expect(
      screen.getByText(/Kein Patientendossier, keine Sitzung und kein PDF-Dokument passt/)
    ).toBeTruthy()
    expect(screen.getByRole('status')).toHaveTextContent(
      'Keine Treffer für «Kündigung Mietwohnung»'
    )
  })

  it('weist auf abgeschnittene Antworten hin', async () => {
    vi.mocked(window.api.search.query).mockImplementation(async (input) =>
      answer(input.requestId, { results: [doc('s1')], truncated: true, semantic: 'model-missing' })
    )
    renderHost()
    await openModal()
    await typeQuery('ich')
    expect(await screen.findByText(/Es gibt weitere Treffer/)).toBeTruthy()
  })
})

describe('Tastatur und Zugänglichkeit', () => {
  it('Combobox mit Listbox, keine Vorauswahl, ↑/↓ setzen aria-activedescendant, ↵ öffnet', async () => {
    renderHost()
    await openModal()
    await typeQuery('Hofer')
    await screen.findByText('Sitzungen und PDF-Dokumente · 3 Treffer')
    const input = screen.getByRole('combobox')
    expect(input).toHaveAttribute('aria-controls', screen.getByRole('listbox').id)
    expect(input).not.toHaveAttribute('aria-activedescendant')
    expect(
      screen.getAllByRole('option').some((o) => o.getAttribute('aria-selected') === 'true')
    ).toBe(false)
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    const last = screen.getAllByRole('option').at(-1)!
    expect(input).toHaveAttribute('aria-activedescendant', last.id)
    expect(last).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input).toHaveAttribute('aria-activedescendant', last.id)
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(route()).toMatchObject({ kind: 'session', sessionId: 's3' })
    expect(window.api.search.recentRemember).toHaveBeenCalledWith('Hofer')
  })

  it('sagt die Trefferzahl an', async () => {
    renderHost()
    await openModal()
    await typeQuery('Hofer')
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        '2 Patientendossiers, 2 Sitzungen und PDF-Dokumente'
      )
    )
  })

  it('↵ ohne Auswahl sucht sofort und merkt die Anfrage', async () => {
    renderHost()
    await openModal()
    const input = screen.getByRole('combobox')
    fireEvent.change(input, { target: { value: 'Angst' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(window.api.search.query).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'Angst' })
    )
    expect(window.api.search.recentRemember).toHaveBeenCalledWith('Angst')
  })
})

describe('Treffer öffnen und zurückkehren (#209 AK 11/12, AK 26)', () => {
  it('öffnet die Fundstelle; ‹ zeigt dieselbe Anfrage, dieselben Treffer an derselben Stelle', async () => {
    renderHost()
    await openModal()
    await typeQuery('Hofer')
    await screen.findByText('Sitzungen und PDF-Dokumente · 3 Treffer')
    const hitOption = screen.getAllByRole('option').find((o) => o.textContent?.includes('Brändli'))!
    const list = screen.getByRole('listbox').parentElement!
    list.scrollTop = 40
    fireEvent.scroll(list)
    await userEvent.click(hitOption)

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(route()).toEqual({
      kind: 'session',
      sessionId: 's1',
      focus: exactHit().focus
    })
    const queriesBefore = vi.mocked(window.api.search.query).mock.calls.length

    await userEvent.click(screen.getByText('Zurück im Verlauf'))
    await screen.findByRole('dialog')
    expect(screen.getByRole('combobox')).toHaveValue('Hofer')
    expect(screen.getByText('Sitzungen und PDF-Dokumente · 3 Treffer')).toBeTruthy()
    const input = screen.getByRole('combobox')
    const active = document.getElementById(input.getAttribute('aria-activedescendant')!)
    expect(active).toHaveTextContent('Brändli')
    expect(screen.getByRole('listbox').parentElement!.scrollTop).toBe(40)
    // Keine neue Suche
    expect(vi.mocked(window.api.search.query).mock.calls.length).toBe(queriesBefore)
  })

  it('öffnet ein gefundenes Dossier und kehrt ebenso zurück', async () => {
    renderHost()
    await openModal()
    await typeQuery('Hofer')
    const dossier = (await screen.findAllByRole('option'))[0]
    await userEvent.click(dossier)
    expect(route()).toEqual({ kind: 'dossier', dossierId: 'd-lukas' })
    await userEvent.click(screen.getByText('Zurück im Verlauf'))
    expect(await screen.findByRole('dialog')).toBeTruthy()
  })

  it('ein Treffer aus einer früheren Fassung führt mit Anker-Suche zur Stelle (#212)', async () => {
    vi.mocked(window.api.search.query).mockImplementation(async (input) =>
      answer(input.requestId, {
        results: [doc('s1', { hits: [semanticHit({ fromEarlierVersion: true })] })],
        semantic: 'model-missing'
      })
    )
    renderHost()
    await openModal()
    await typeQuery('Schlaf')
    await screen.findByText('[PERSON 1] Sitzung s1')
    await userEvent.click(screen.getAllByRole('option')[1])
    expect(route()).toMatchObject({
      kind: 'session',
      sessionId: 's1',
      focus: { kind: 'hit', fromEarlierVersion: true, anchor: 'Ein- und Durchschlafstörungen' }
    })
  })

  it('der Kopf eines Dokuments öffnet es oben (ohne Fundstelle)', async () => {
    renderHost()
    await openModal()
    await typeQuery('Hofer')
    await screen.findByText('Sitzungen und PDF-Dokumente · 2 Treffer')
    await userEvent.click(screen.getAllByRole('option')[2])
    expect(route()).toEqual({ kind: 'session', sessionId: 's1' })
  })

  it('entfernt gelöschte Sitzungen aus den gemerkten Treffern', async () => {
    renderHost()
    await openModal()
    await typeQuery('Hofer')
    await screen.findByText('Sitzungen und PDF-Dokumente · 3 Treffer')
    act(() => emitApiEvent(window.api, 'sessions.onChanged', { deletedIds: ['s1'] }))
    expect(screen.queryByText(/Sitzung s1/)).toBeNull()
    expect(screen.getByText('Sitzungen und PDF-Dokumente · 2 Treffer')).toBeTruthy()
  })

  it('verwirft Anfrage und Klartext-Ausschnitte, sobald ein Dossier aus den Treffern gelöscht wird', async () => {
    renderHost()
    await openModal()
    await typeQuery('Hofer')
    await screen.findByText('Sitzungen und PDF-Dokumente · 3 Treffer')
    act(() => emitApiEvent(window.api, 'dossiers.onChanged', { deletedIds: ['d-lukas'] }))
    expect(screen.getByRole('combobox')).toHaveValue('')
    expect(screen.queryByText(/Brändli/)).toBeNull()
    expect(screen.queryByText('PD-1188 · 03.02.1978')).toBeNull()
  })
})

describe('Verfügbarkeit der Suche nach Bedeutung (#209 AK 18, #210 AK 4/5)', () => {
  function withAvailability(availability: SearchAvailability): void {
    vi.mocked(window.api.search.open).mockResolvedValue(availability)
  }

  it('während einer Verarbeitung: Hinweis, exakte Treffer gehen weiter', async () => {
    withAvailability({ model: { status: 'ready' }, semantic: 'unavailable-processing' })
    vi.mocked(window.api.search.query).mockImplementation(async (input) =>
      answer(input.requestId, { results: [doc('s1')], semantic: 'unavailable-processing' })
    )
    renderHost()
    await openModal()
    const note = await screen.findByRole('note', {
      name: 'Suche nach Bedeutung während der Verarbeitung nicht verfügbar'
    })
    expect(note).toHaveTextContent(
      'Die Suche nach Bedeutung ist verfügbar, sobald die Verarbeitung abgeschlossen ist.'
    )
    expect(note).toHaveTextContent('Genaue Begriffe, Klarnamen und Patientendossiers finden Sie')
    await typeQuery('Brändli')
    expect(await screen.findByText('[PERSON 1] Sitzung s1')).toBeTruthy()
    expect(window.api.search.semantic).not.toHaveBeenCalled()
  })

  it('holt die Suche nach Bedeutung nach, sobald sie wieder verfügbar ist', async () => {
    withAvailability({ model: { status: 'ready' }, semantic: 'unavailable-processing' })
    vi.mocked(window.api.search.query).mockImplementation(async (input) =>
      answer(input.requestId, { results: [doc('s1')], semantic: 'unavailable-processing' })
    )
    renderHost()
    await openModal()
    await typeQuery('Brändli')
    await screen.findByText('[PERSON 1] Sitzung s1')
    act(() => emitApiEvent(window.api, 'search.onAvailabilityChanged', READY))
    await waitFor(() => expect(window.api.search.semantic).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('[PERSON 1] Sitzung s3')).toBeTruthy()
    expect(screen.queryByRole('note', { name: /Suche nach Bedeutung/ })).toBeNull()
  })

  it('Suchmodell lädt: erkennbar, dass die Suche erst danach verfügbar ist, mit Fortschritt', async () => {
    withAvailability({ model: { status: 'downloading', progress: 42 }, semantic: 'model-missing' })
    renderHost()
    await openModal()
    const note = await screen.findByRole('note', {
      name: 'Suche nach Bedeutung erst nach dem Laden des Suchmodells verfügbar'
    })
    expect(note).toHaveTextContent('sobald das Suchmodell geladen ist')
    expect(within(note).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '42')
  })

  it('Laden gescheitert: Grund und «Erneut versuchen»', async () => {
    withAvailability({
      model: { status: 'failed', reason: 'disk-space' },
      semantic: 'model-missing'
    })
    renderHost()
    await openModal()
    const note = await screen.findByRole('note', {
      name: 'Das Suchmodell konnte nicht geladen werden'
    })
    expect(note).toHaveTextContent('nicht genügend Speicherplatz')
    await userEvent.click(within(note).getByRole('button', { name: 'Erneut versuchen' }))
    expect(window.api.search.retryModel).toHaveBeenCalledTimes(1)
  })

  it('zeigt den Grund aus semanticMessage', async () => {
    withAvailability({
      model: { status: 'ready' },
      semantic: 'error',
      semanticMessage: 'Der Suchdienst liess sich dreimal nicht starten.'
    })
    renderHost()
    await openModal()
    expect(
      await screen.findByRole('note', { name: 'Suche nach Bedeutung gerade nicht verfügbar' })
    ).toHaveTextContent('Der Suchdienst liess sich dreimal nicht starten.')
  })

  it('ein Abbruch gilt nicht mehr, sobald eine Anfrage die Suche nach Bedeutung liefert', async () => {
    withAvailability({ model: { status: 'ready' }, semantic: 'error' })
    renderHost()
    await openModal()
    await screen.findByRole('note', { name: /Suche nach Bedeutung/ })
    await typeQuery('Hofer')
    await screen.findByText('[PERSON 1] Sitzung s3')
    expect(screen.queryByRole('note', { name: /Suche nach Bedeutung/ })).toBeNull()
  })

  it('Werkzeug blockiert', async () => {
    withAvailability({ model: { status: 'ready' }, semantic: 'tool-blocked' })
    renderHost()
    await openModal()
    expect(
      await screen.findByRole('note', { name: 'Suche nach Bedeutung blockiert' })
    ).toHaveTextContent('macOS hat ein Werkzeug von Therascript blockiert')
  })

  it('Suchdienst abgebrochen: «Erneut versuchen» wiederholt die Suche nach Bedeutung', async () => {
    vi.mocked(window.api.search.semantic)
      .mockImplementationOnce(async (input) =>
        answer(input.requestId, { results: [doc('s1')], semantic: 'error' })
      )
      .mockImplementation(async (input) =>
        answer(input.requestId, { results: [doc('s1'), doc('s3')], semantic: 'complete' })
      )
    vi.mocked(window.api.search.open).mockResolvedValue({
      model: { status: 'ready' },
      semantic: 'loading'
    })
    renderHost()
    await openModal()
    await typeQuery('Brändli')
    const note = await screen.findByRole('note', {
      name: 'Suche nach Bedeutung gerade nicht verfügbar'
    })
    await userEvent.click(within(note).getByRole('button', { name: 'Erneut versuchen' }))
    expect(await screen.findByText('[PERSON 1] Sitzung s3')).toBeTruthy()
  })
})

describe('Review S5: Fokus, Kopieren, Reihenfolge, Fehler, Leistung', () => {
  it('Esc mit Fokus auf body schliesst nur das Suchfenster; Tab holt den Fokus zurück', async () => {
    renderHost()
    const below = vi.fn()
    const windowHandler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented) below()
    }
    window.addEventListener('keydown', windowHandler)
    const dialog = await openModal()
    // Klick auf Text ohne Fokus: der Fokus bleibt im Feld
    fireEvent.mouseDown(within(dialog).getByText(/Dossiers über Name oder ID/))
    expect(screen.getByRole('combobox')).toHaveFocus()
    ;(document.activeElement as HTMLElement).blur()
    expect(document.activeElement).toBe(document.body)
    fireEvent.keyDown(document.body, { key: 'Tab' })
    expect(dialog.contains(document.activeElement)).toBe(true)
    ;(document.activeElement as HTMLElement).blur()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(below).not.toHaveBeenCalled()
    window.removeEventListener('keydown', windowHandler)
  })

  it('pseudonymisierte Ansicht: Ausschnitte nicht auswählbar, deutlicher Hinweis im Listenkopf', async () => {
    renderHost()
    await openModal()
    await typeQuery('Hofer')
    await screen.findByText('Sitzungen und PDF-Dokumente · 2 Treffer')
    expect(screen.getByTestId('search-results')).toHaveClass('select-none')
    expect(screen.getByRole('note', { name: 'Ausschnitte im Klartext' })).toHaveTextContent(
      'Auswählen und kopieren lassen sie sich nur in der Klartext-Ansicht'
    )
  })

  it('Klartext-Ansicht: Ausschnitte auswählbar, nur der dezente Hinweis', async () => {
    renderHost()
    act(() => setViewMode('plain'))
    await openModal()
    await typeQuery('Hofer')
    await screen.findByText('Sitzungen und PDF-Dokumente · 2 Treffer')
    expect(screen.getByTestId('search-results')).not.toHaveClass('select-none')
    expect(screen.queryByRole('note', { name: 'Ausschnitte im Klartext' })).toBeNull()
  })

  it('eine Maus über der Liste ändert nichts: es gilt die Reihenfolge der zweiten Antwort', async () => {
    const second = deferred<ReturnType<typeof answer>>()
    vi.mocked(window.api.search.semantic).mockImplementation(async (input) => ({
      ...(await second.promise),
      requestId: input.requestId
    }))
    renderHost()
    await openModal()
    await typeQuery('Hofer')
    await screen.findByText('Sitzungen und PDF-Dokumente · 2 Treffer')
    fireEvent.mouseMove(screen.getByTestId('search-results'))
    second.resolve(answer(0, { results: [doc('s3', { hits: [semanticHit()] }), doc('s1')] }))
    await waitFor(() => expect(screen.queryByTestId('semantic-pending')).toBeNull())
    expect(screen.getAllByRole('option')[0]).toHaveTextContent('Sitzung s3')
    expect(screen.queryByRole('button', { name: /nach Relevanz sortieren/ })).toBeNull()
  })

  it('nach Interaktion: Positionen bleiben, neue Fundstellen erscheinen, «nach Relevanz sortieren» stellt die Antwort her', async () => {
    const second = deferred<ReturnType<typeof answer>>()
    vi.mocked(window.api.search.semantic).mockImplementation(async (input) => ({
      ...(await second.promise),
      requestId: input.requestId
    }))
    renderHost()
    await openModal()
    await typeQuery('Hofer')
    await screen.findByText('Sitzungen und PDF-Dokumente · 2 Treffer')
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' })
    second.resolve(
      answer(0, {
        dossiers: [DOSSIER_HOFER_LUKAS, DOSSIER_HOFER_LUKAS_2],
        results: [
          doc('s3', { hits: [semanticHit()] }),
          doc('s1', {
            hits: [
              exactHit(),
              semanticHit({ snippet: { ...semanticHit().snippet, text: 'Neue Stelle in s1' } })
            ]
          }),
          doc('s2')
        ]
      })
    )
    await waitFor(() => expect(screen.queryByTestId('semantic-pending')).toBeNull())
    const titles = (): string[] =>
      screen
        .getAllByRole('option')
        .map((o) => o.textContent ?? '')
        .filter((t) => t.includes('Sitzung s'))
        .map((t) => t.match(/Sitzung (s\d)/)![1])
    expect(titles()).toEqual(['s1', 's2', 's3'])
    // Neue Fundstelle des bekannten Dokuments erscheint
    expect(screen.getByText(/Neue Stelle in s1/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /nach Relevanz sortieren/ }))
    expect(titles()).toEqual(['s3', 's1', 's2'])
  })

  it('beim erneuten Öffnen gilt wieder die Reihenfolge der Antwort', async () => {
    const second = deferred<ReturnType<typeof answer>>()
    vi.mocked(window.api.search.semantic).mockImplementation(async (input) => ({
      ...(await second.promise),
      requestId: input.requestId
    }))
    renderHost()
    await openModal()
    await typeQuery('Hofer')
    await screen.findByText('Sitzungen und PDF-Dokumente · 2 Treffer')
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' })
    second.resolve(
      answer(0, { results: [doc('s3', { hits: [semanticHit()] }), doc('s1'), doc('s2')] })
    )
    await screen.findByRole('button', { name: /nach Relevanz sortieren/ })
    act(() => emitApiEvent(window.api, 'nav.onCommand', 'search'))
    await openModal()
    expect(screen.queryByRole('button', { name: /nach Relevanz sortieren/ })).toBeNull()
    expect(screen.getAllByRole('option')[0]).toHaveTextContent('Sitzung s3')
  })

  it('holt bei wieder verfügbarer Bedeutungssuche die aktuelle Eingabe, nicht die alte Anfrage', async () => {
    vi.mocked(window.api.search.open).mockResolvedValue({
      model: { status: 'ready' },
      semantic: 'unavailable-processing'
    })
    vi.mocked(window.api.search.query).mockImplementation(async (input) =>
      answer(input.requestId, { results: [doc(input.query)], semantic: 'unavailable-processing' })
    )
    renderHost()
    await openModal()
    await typeQuery('Ho')
    await screen.findByText('[PERSON 1] Sitzung Ho')
    // Neue Eingabe läuft noch in der Entprellung
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Hofer' } })
    act(() => emitApiEvent(window.api, 'search.onAvailabilityChanged', READY))
    await screen.findByText('[PERSON 1] Sitzung Hofer')
    expect(vi.mocked(window.api.search.semantic).mock.calls.every((c) => c[0].query !== 'Ho')).toBe(
      true
    )
  })

  it('⌘, (Einstellungen) schliesst das Suchfenster', async () => {
    renderHost()
    await openModal()
    act(() => emitApiEvent(window.api, 'nav.onOpenSettings'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('zeigt einen Fehler der exakten Suche nicht als «Keine Treffer», mit «Erneut versuchen»', async () => {
    vi.mocked(window.api.search.query)
      .mockRejectedValueOnce(new Error('kaputt'))
      .mockImplementation(async (input) =>
        answer(input.requestId, { results: [doc('s1')], semantic: 'model-missing' })
      )
    renderHost()
    await openModal()
    await typeQuery('Hofer')
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Die Suche ist fehlgeschlagen.')
    expect(screen.queryByText(/Keine Treffer/)).toBeNull()
    await userEvent.click(within(alert).getByRole('button', { name: 'Erneut versuchen' }))
    expect(await screen.findByText('[PERSON 1] Sitzung s1')).toBeTruthy()
  })

  it('Tippen und Scrollen rendern die Zeilen nicht neu', async () => {
    renderHost()
    await openModal()
    await typeQuery('Hofer')
    await screen.findByText('Sitzungen und PDF-Dokumente · 3 Treffer')
    const before = searchRowRenders.count
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Hofer ' } })
    const list = screen.getByTestId('search-results')
    list.scrollTop = 30
    fireEvent.scroll(list)
    expect(searchRowRenders.count).toBe(before)
    // Pfeiltaste: nur die beiden betroffenen Zeilen
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' })
    expect(searchRowRenders.count - before).toBeLessThanOrEqual(2)
  })
})
