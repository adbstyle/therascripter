import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import RecentList from '../RecentList'
import { NavigationProvider } from '../../../navigation/NavigationContext'
import { useNavigation } from '../../../navigation/navigation'
import { routeKey, type Route } from '../../../navigation/routes'
import { useRememberOpenedRoute } from '../../../hooks/useRememberOpenedRoute'
import { createMockApi, emitApiEvent, makeSession } from '../../../test/mockApi'
import { makeDossierRef } from '../../../test/dossierFixtures'
import { getViewModeStore, _resetViewModeStoreForTests } from '../../../viewMode/viewModeStore'
import type { RecentEntry } from '../../../../../shared/types/Recent'

/** #213 AK 1–4 — «Zuletzt geöffnet» in der Seitenleiste. */

function Probe(): React.JSX.Element {
  const nav = useNavigation()
  return (
    <div>
      <p data-testid="route">{routeKey(nav.route)}</p>
      <p data-testid="anchor">{nav.anchorId ?? ''}</p>
      <button onClick={() => nav.navigate({ kind: 'dossier', dossierId: 'd1' })}>
        Dossier öffnen
      </button>
      <button onClick={() => nav.navigate({ kind: 'session', sessionId: 's1' })}>
        Sitzung öffnen
      </button>
      <button
        onClick={() => nav.navigate({ kind: 'session', sessionId: 's1', focus: { kind: 'title' } })}
      >
        Stelle öffnen
      </button>
      <button onClick={() => nav.navigate({ kind: 'settings', subpage: null })}>
        Einstellungen öffnen
      </button>
    </div>
  )
}

function Remember(): null {
  useRememberOpenedRoute()
  return null
}

function renderList(entries: RecentEntry[], route?: Route) {
  window.api = createMockApi({ recent: { list: vi.fn().mockResolvedValue(entries) } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <NavigationProvider initialRoute={route}>
      {children}
      <Probe />
    </NavigationProvider>
  )
  render(<RecentList />, { wrapper })
  return userEvent.setup()
}

const hofer: RecentEntry = {
  kind: 'dossier',
  dossier: makeDossierRef({ id: 'd1', firstName: 'Lukas', lastName: 'Hofer' })
}
const erstgespraech: RecentEntry = {
  kind: 'session',
  recording: false,
  session: makeSession({
    id: 's1',
    type: 'audio',
    status: 'review',
    title: 'Erstgespräch mit [PERSON 1]',
    titlePlain: 'Erstgespräch mit Sandra Meier'
  })
}
const bericht: RecentEntry = {
  kind: 'session',
  recording: false,
  session: makeSession({
    id: 'p1',
    type: 'pdf',
    status: 'processing',
    title: 'Bericht [ORT 1]',
    titlePlain: 'Bericht Winterthur'
  })
}
const laufend: RecentEntry = {
  kind: 'session',
  recording: true,
  session: makeSession({
    id: 'rec-1',
    type: 'audio',
    status: 'recording',
    title: 'Aufnahme 14.11.2026 10:05'
  })
}

beforeEach(() => {
  _resetViewModeStoreForTests()
})
afterEach(() => {
  _resetViewModeStoreForTests()
})

describe('RecentList (#213)', () => {
  it('zeigt einen Hinweis, solange nichts geöffnet wurde', async () => {
    renderList([])
    expect(
      await screen.findByText('Geöffnete Dossiers und Transkriptionen erscheinen hier.')
    ).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Zuletzt geöffnet' })).toBeInTheDocument()
  })

  it('zeigt die Einträge in der Reihenfolge des Main-Prozesses, die Aufnahme zuerst (AK 1/2)', async () => {
    renderList([laufend, hofer, erstgespraech, bericht])
    const list = await screen.findByRole('list')
    const buttons = within(list).getAllByRole('button')
    expect(buttons.map((b) => b.textContent)).toEqual([
      'Aufnahme 14.11.2026 10:05',
      'Hofer, Lukas',
      'Erstgespräch mit [PERSON 1]',
      'Bericht [ORT 1]'
    ])
    expect(within(buttons[0]).getByRole('img', { name: 'Aufnahme läuft' })).toBeInTheDocument()
    expect(within(buttons[1]).queryByRole('img', { name: 'Aufnahme läuft' })).toBeNull()
  })

  it('macht die Art jedes Eintrags erkennbar — Icon mit zugänglichem Namen (AK 3)', async () => {
    renderList([hofer, erstgespraech, bericht])
    const list = await screen.findByRole('list')
    const kinds = within(list)
      .getAllByRole('button')
      .map((b) =>
        within(b)
          .getAllByRole('img')
          .map((i) => i.getAttribute('aria-label'))
      )
    expect(kinds).toEqual([['Patientendossier'], ['Sitzung'], ['PDF-Dokument']])
    expect(
      screen.getByRole('button', { name: 'Sitzung Erstgespräch mit [PERSON 1]' })
    ).toBeInTheDocument()
  })

  it('zeigt Titel in der gewählten Ansicht — pseudonymisiert ohne Klarnamen, auch nicht in title/aria (AK 4)', async () => {
    window.api = createMockApi()
    getViewModeStore().set('pseudonymized')
    renderList([erstgespraech, bericht])
    const region = await screen.findByRole('region', { name: 'Zuletzt geöffnet' })
    await within(region).findByText('Erstgespräch mit [PERSON 1]')
    for (const clear of ['Sandra', 'Meier', 'Winterthur']) {
      expect(region.innerHTML).not.toContain(clear)
    }

    act(() => getViewModeStore().set('plain'))
    expect(within(region).getByText('Erstgespräch mit Sandra Meier')).toBeInTheDocument()
    expect(within(region).getByText('Bericht Winterthur')).toBeInTheDocument()
    expect(
      within(region).getByRole('button', { name: 'Sitzung Erstgespräch mit Sandra Meier' })
    ).toHaveAttribute('title', 'Sitzung: Erstgespräch mit Sandra Meier')
  })

  it('öffnet Dossier und fertige Sitzung; ein nicht fertiger Eintrag führt zur Liste und markiert die Karte', async () => {
    const user = renderList([hofer, erstgespraech, bericht, laufend])
    await user.click(await screen.findByRole('button', { name: 'Patientendossier Hofer, Lukas' }))
    expect(screen.getByTestId('route')).toHaveTextContent('dossier:d1')
    expect(screen.getByRole('button', { name: 'Patientendossier Hofer, Lukas' })).toHaveAttribute(
      'aria-current',
      'page'
    )

    await user.click(screen.getByRole('button', { name: 'Sitzung Erstgespräch mit [PERSON 1]' }))
    expect(screen.getByTestId('route')).toHaveTextContent('session:s1')

    await user.click(screen.getByRole('button', { name: 'PDF-Dokument Bericht [ORT 1]' }))
    expect(screen.getByTestId('route')).toHaveTextContent('sessions')
    expect(screen.getByTestId('anchor')).toHaveTextContent('p1')

    await user.click(screen.getByRole('button', { name: /Aufnahme 14\.11\.2026/ }))
    expect(screen.getByTestId('route')).toHaveTextContent('sessions')
    expect(screen.getByTestId('anchor')).toHaveTextContent('rec-1')
  })

  it('lädt nach und lässt Gelöschtes sofort verschwinden (PC 2)', async () => {
    renderList([hofer, erstgespraech])
    await screen.findByText('Hofer, Lukas')
    vi.mocked(window.api.recent.list).mockResolvedValue([erstgespraech])
    act(() => emitApiEvent(window.api, 'dossiers.onChanged', { deletedIds: ['d1'] }))
    await waitFor(() => expect(screen.queryByText('Hofer, Lukas')).not.toBeInTheDocument())

    vi.mocked(window.api.recent.list).mockResolvedValue([])
    act(() => emitApiEvent(window.api, 'sessions.onChanged', { deletedIds: ['s1'] }))
    expect(
      await screen.findByText('Geöffnete Dossiers und Transkriptionen erscheinen hier.')
    ).toBeInTheDocument()

    vi.mocked(window.api.recent.list).mockResolvedValue([laufend])
    act(() => emitApiEvent(window.api, 'recent.onChanged'))
    expect(await screen.findByText('Aufnahme 14.11.2026 10:05')).toBeInTheDocument()
  })
})

describe('useRememberOpenedRoute (#213)', () => {
  it('merkt geöffnete Dossiers und Sitzungen, nicht andere Seiten und nicht eine andere Stelle', async () => {
    window.api = createMockApi()
    render(
      <NavigationProvider>
        <Remember />
        <Probe />
      </NavigationProvider>
    )
    const user = userEvent.setup()
    expect(window.api.recent.touch).not.toHaveBeenCalled()

    await user.click(screen.getByText('Dossier öffnen'))
    expect(window.api.recent.touch).toHaveBeenLastCalledWith({ kind: 'dossier', id: 'd1' })
    await user.click(screen.getByText('Sitzung öffnen'))
    expect(window.api.recent.touch).toHaveBeenLastCalledWith({ kind: 'session', id: 's1' })
    await user.click(screen.getByText('Stelle öffnen'))
    await user.click(screen.getByText('Einstellungen öffnen'))
    expect(window.api.recent.touch).toHaveBeenCalledTimes(2)
  })
})
