import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import DossierSearchPage from '../DossierSearchPage'
import RouteView from '../../components/shell/RouteView'
import { SearchHost } from '../../components/search/SearchHost'
import { renderWithProviders } from '../../test/renderWithProviders'
import { createMockApi, emitApiEvent } from '../../test/mockApi'
import { useNavigation } from '../../navigation/navigation'
import {
  _resetSearchSessionForTests,
  getSearchEntry,
  searchEntryKey
} from '../../stores/searchSession'
import { _resetViewModeStoreForTests, setViewMode } from '../../viewMode/viewModeStore'
import { answer, doc, exactHit } from '../../components/search/__tests__/searchFixtures'
import type { Dossier } from '../../../../shared/types/Dossier'
import type { SearchQueryInput } from '../../../../shared/types/Search'

/**
 * #211 — Suche in einem Patientendossier: Bereich erkennbar (AK 2), Anfrage
 * nur in diesem Dossier (AK 1), keine Dossier-Treffer, nicht unter «Letzte
 * Suchen» (OOS 3), Anfrage und Treffer bleiben bis zur nächsten Suche oder
 * zum Löschen des Dossiers (AK 4).
 */

vi.mock('../ReviewEditor', () => ({
  default: ({ sessionId, onBack }: { sessionId: string; onBack: () => void }) => (
    <div>
      <p>Editor {sessionId}</p>
      <button onClick={onBack}>Editor verlassen</button>
    </div>
  )
}))

const DOSSIER: Dossier = {
  id: 'd1',
  firstName: 'Lukas',
  lastName: 'Hofer',
  externalId: 'PD-1188',
  birthDate: '1978-02-03',
  diagnoses: '',
  medication: '',
  note: '',
  createdAt: '2026-10-01T08:00:00.000Z',
  updatedAt: '2026-10-01T08:00:00.000Z'
}

function RouteProbe(): React.JSX.Element {
  const { route } = useNavigation()
  return <p data-testid="route">{JSON.stringify(route)}</p>
}

beforeEach(() => {
  _resetSearchSessionForTests()
  _resetViewModeStoreForTests()
  window.api = createMockApi({
    dossiers: { get: vi.fn().mockResolvedValue(DOSSIER) },
    search: {
      query: vi.fn().mockImplementation(async (input: SearchQueryInput) =>
        answer(input.requestId, {
          // Der Main-Prozess liefert bei einer Dossier-Suche keine Dossiers
          dossiers: [],
          results: [doc('s1', { hits: [exactHit()] })],
          semantic: 'model-missing'
        })
      )
    }
  })
})

afterEach(() => _resetSearchSessionForTests())

async function search(text: string): Promise<void> {
  const input = await screen.findByRole('combobox', {
    name: 'Suchanfrage im Patientendossier Hofer, Lukas'
  })
  fireEvent.change(input, { target: { value: text } })
  await screen.findByText('[PERSON 1] Sitzung s1')
}

describe('Suche im Patientendossier (#211)', () => {
  it('nennt den Bereich und sucht nur in diesem Dossier', async () => {
    renderWithProviders(<DossierSearchPage dossierId="d1" />, {
      route: { kind: 'dossierSearch', dossierId: 'd1' }
    })
    expect(await screen.findByText('Suche im Patientendossier')).toBeTruthy()
    expect(await screen.findByRole('button', { name: 'Hofer, Lukas' })).toBeTruthy()
    await search('Brändli')
    expect(window.api.search.query).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'Brändli', scope: { kind: 'dossier', dossierId: 'd1' } })
    )
    expect(screen.getByText('1 Dokument · Ausschnitte im Klartext')).toBeTruthy()
    expect(screen.queryByRole('group', { name: 'Patientendossiers' })).toBeNull()
  })

  it('nimmt die Anfrage nicht unter «Letzte Suchen» auf — auch nicht beim Öffnen eines Treffers', async () => {
    renderWithProviders(
      <>
        <RouteProbe />
        <RouteView />
      </>,
      { route: { kind: 'dossierSearch', dossierId: 'd1' } }
    )
    await search('Brändli')
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' })
    const hit = screen.getAllByRole('option').find((o) => o.textContent?.includes('Brändli'))!
    await userEvent.click(hit)
    expect(JSON.parse(screen.getByTestId('route').textContent!)).toMatchObject({
      kind: 'session',
      sessionId: 's1',
      focus: { kind: 'hit' }
    })
    expect(window.api.search.recentRemember).not.toHaveBeenCalled()
  })

  it('zeigt nach dem Schliessen der Sitzung dieselbe Anfrage und dieselben Treffer (AK 4)', async () => {
    renderWithProviders(
      <>
        <RouteProbe />
        <RouteView />
      </>,
      { route: { kind: 'dossierSearch', dossierId: 'd1' } }
    )
    await search('Brändli')
    await userEvent.click(screen.getAllByRole('option')[1])
    await userEvent.click(await screen.findByText('Editor verlassen'))
    expect(await screen.findByText('[PERSON 1] Sitzung s1')).toBeTruthy()
    expect(screen.getByRole('combobox')).toHaveValue('Brändli')
    expect(window.api.search.query).toHaveBeenCalledTimes(1)
  })

  it('verwirft Anfrage und Treffer, wenn das Dossier gelöscht wird', async () => {
    renderWithProviders(
      <>
        <SearchHost />
        <DossierSearchPage dossierId="d1" />
      </>,
      { route: { kind: 'dossierSearch', dossierId: 'd1' } }
    )
    await search('Brändli')
    const key = searchEntryKey({ kind: 'dossier', dossierId: 'd1' })
    expect(getSearchEntry(key).submitted).toBe('Brändli')
    act(() => emitApiEvent(window.api, 'dossiers.onChanged', { deletedIds: ['d1'] }))
    expect(getSearchEntry(key).submitted).toBeNull()
  })

  it('hält die Suche pro Dossier getrennt', async () => {
    const { unmount } = renderWithProviders(<DossierSearchPage dossierId="d1" />, {
      route: { kind: 'dossierSearch', dossierId: 'd1' }
    })
    await search('Brändli')
    unmount()
    renderWithProviders(<DossierSearchPage dossierId="d2" />, {
      route: { kind: 'dossierSearch', dossierId: 'd2' }
    })
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue(''))
  })

  it('zeigt die Reihenfolge der Antwort (#211 AK 3) und Klartext-Ausschnitte nur in «Klartext» auswählbar', async () => {
    vi.mocked(window.api.search.query).mockImplementation(async (input) =>
      answer(input.requestId, {
        results: [doc('s2'), doc('s1'), doc('s3')],
        semantic: 'model-missing'
      })
    )
    renderWithProviders(<DossierSearchPage dossierId="d1" />, {
      route: { kind: 'dossierSearch', dossierId: 'd1' }
    })
    await search('Brändli')
    const headers = screen
      .getAllByRole('option')
      .filter((o) => !o.textContent?.includes('Brändli'))
      .map((o) => o.textContent?.match(/Sitzung (s\d)/)?.[1])
    expect(headers).toEqual(['s2', 's1', 's3'])
    expect(screen.getByTestId('search-results')).toHaveClass('select-none')
    expect(screen.getByRole('note', { name: 'Ausschnitte im Klartext' })).toBeTruthy()
    act(() => setViewMode('plain'))
    expect(screen.getByTestId('search-results')).not.toHaveClass('select-none')
    expect(screen.queryByRole('note', { name: 'Ausschnitte im Klartext' })).toBeNull()
  })

  it('nach Pfeiltasten bleiben die Positionen, «nach Relevanz sortieren» stellt die Antwort her', async () => {
    vi.mocked(window.api.search.query).mockImplementation(async (input) =>
      answer(input.requestId, { results: [doc('s1'), doc('s2')], semantic: 'pending' })
    )
    vi.mocked(window.api.search.semantic).mockImplementation(async (input) =>
      answer(input.requestId, { results: [doc('s3'), doc('s2'), doc('s1')], semantic: 'complete' })
    )
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const semantic = vi.mocked(window.api.search.semantic).getMockImplementation()!
    vi.mocked(window.api.search.semantic).mockImplementation(async (input) => {
      await gate
      return semantic(input)
    })
    renderWithProviders(<DossierSearchPage dossierId="d1" />, {
      route: { kind: 'dossierSearch', dossierId: 'd1' }
    })
    await search('Brändli')
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' })
    release()
    const sort = await screen.findByRole('button', { name: /nach Relevanz sortieren/ })
    const order = (): Array<string | undefined> =>
      screen
        .getAllByRole('option')
        .filter((o) => !o.textContent?.includes('Brändli'))
        .map((o) => o.textContent?.match(/Sitzung (s\d)/)?.[1])
    expect(order()).toEqual(['s1', 's2', 's3'])
    await userEvent.click(sort)
    expect(order()).toEqual(['s3', 's2', 's1'])
  })

  it('meldet keine Treffer mit dem Hinweis auf die Suche über alle Inhalte', async () => {
    vi.mocked(window.api.search.query).mockImplementation(async (input) =>
      answer(input.requestId, { semantic: 'complete' })
    )
    renderWithProviders(<DossierSearchPage dossierId="d1" />, {
      route: { kind: 'dossierSearch', dossierId: 'd1' }
    })
    const input = await screen.findByRole('combobox', {
      name: 'Suchanfrage im Patientendossier Hofer, Lukas'
    })
    fireEvent.change(input, { target: { value: 'Kündigung Mietwohnung' } })
    expect(
      await screen.findByText(/Im Patientendossier Hofer, Lukas passt keine Stelle/)
    ).toHaveTextContent('Für alle Inhalte suchen Sie mit ⌘K.')
  })
})
