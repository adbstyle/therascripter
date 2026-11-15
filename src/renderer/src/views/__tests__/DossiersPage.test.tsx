import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Profiler } from 'react'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import DossiersPage from '../DossiersPage'
import { renderWithProviders } from '../../test/renderWithProviders'
import { createMockApi, emitApiEvent } from '../../test/mockApi'
import { makeDossierListItem } from '../../test/dossierFixtures'
import { localTodayIso } from '../../../../shared/utils/calendar-date'

const LIST = [
  makeDossierListItem({
    id: 'd1',
    firstName: 'Lea',
    lastName: 'Bachmann',
    externalId: 'PD-1042',
    birthDate: '1991-03-14',
    entryCount: 12,
    lastEntryDay: localTodayIso()
  }),
  makeDossierListItem({
    id: 'd2',
    firstName: 'Anna',
    lastName: 'Meier',
    externalId: 'PD-0412',
    birthDate: '1969-06-11',
    entryCount: 1,
    lastEntryDay: '2025-10-28'
  }),
  makeDossierListItem({
    id: 'd3',
    firstName: 'Anna',
    lastName: 'Meier',
    externalId: null,
    birthDate: null,
    entryCount: 0,
    lastEntryDay: null
  }),
  makeDossierListItem({ id: 'd4', firstName: 'Jürg', lastName: 'Müller', externalId: 'PD-7' })
]

function renderPage(list = LIST) {
  window.api = createMockApi({ dossiers: { list: vi.fn().mockResolvedValue(list) } })
  return renderWithProviders(<DossiersPage />, { route: { kind: 'dossiers' } })
}

const rowNames = (): string[] =>
  within(screen.getByRole('list', { name: 'Patientendossiers' }))
    .getAllByRole('button')
    .map((b) => b.querySelector('span')?.textContent ?? '')

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

describe('DossiersPage (#204 AK 12–15)', () => {
  it('zeigt alle Dossiers in der Reihenfolge des Main-Prozesses mit Anzahl und Angaben', async () => {
    renderPage()
    expect(await screen.findByRole('heading', { name: 'Patientendossiers' })).toBeInTheDocument()
    expect(screen.getByText('4')).toBeInTheDocument()
    expect(rowNames()).toEqual(['Bachmann, Lea', 'Meier, Anna', 'Meier, Anna', 'Müller, Jürg'])
    const first = screen.getAllByRole('button', { name: /Bachmann, Lea/ })[0]
    expect(first).toHaveTextContent('PD-1042 · 14.03.1991')
    expect(first).toHaveTextContent('12 Einträge')
    expect(first).toHaveTextContent('Heute')
    const meier = screen.getAllByRole('button', { name: /Meier, Anna/ })
    expect(meier[0]).toHaveTextContent('1 Eintrag')
    expect(meier[0]).toHaveTextContent('28.10.2025')
    expect(meier[1]).toHaveTextContent('Keine Einträge')
    // Keine Gesundheitsdaten in der Übersicht
    expect(screen.queryByText(/Diagnose/)).not.toBeInTheDocument()
  })

  it('alle Zeilen teilen ein festes Spaltenraster ohne auto-Spalte (Sichtprüfung)', async () => {
    renderPage()
    await screen.findByRole('heading', { name: 'Patientendossiers' })
    const rows = within(screen.getByRole('list', { name: 'Patientendossiers' })).getAllByRole(
      'button'
    )
    const templates = rows.map(
      (r) => r.className.split(' ').find((c) => c.startsWith('grid-cols-')) ?? ''
    )
    expect(new Set(templates).size).toBe(1)
    expect(templates[0]).not.toMatch(/auto/)
    expect(templates[0]).toMatch(/_\d+(\.\d+)?rem_\d+(\.\d+)?rem\]$/)
  })

  it('erklärt in der leeren Übersicht, wie man ein Dossier anlegt (AK 13)', async () => {
    const user = userEvent.setup()
    renderPage([])
    expect(
      await screen.findByRole('heading', { name: 'Noch keine Patientendossiers' })
    ).toBeInTheDocument()
    expect(screen.getByText(/Legen Sie es mit Vor- und Nachnamen an/)).toBeInTheDocument()
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
    const buttons = screen.getAllByRole('button', { name: 'Neues Patientendossier' })
    await user.click(buttons[buttons.length - 1])
    expect(
      await screen.findByRole('dialog', { name: 'Neues Patientendossier' })
    ).toBeInTheDocument()
  })

  it('filtert nach Teilen von Vor- und Nachnamen, auch zusammen und mit Umlauten (AK 14)', async () => {
    const user = userEvent.setup()
    renderPage()
    const filter = await screen.findByRole('searchbox', { name: 'Nach Namen filtern' })
    await user.type(filter, 'ann mei')
    await waitFor(() => expect(rowNames()).toEqual(['Meier, Anna', 'Meier, Anna']))
    await user.clear(filter)
    await user.type(filter, 'MUELL')
    await waitFor(() => expect(rowNames()).toEqual(['Müller, Jürg']))
    await user.clear(filter)
    await user.type(filter, 'PD-1042')
    // Nicht nach ID (OOS 2)
    expect(await screen.findByText('Kein Patientendossier passt zu «PD-1042».')).toBeInTheDocument()
  })

  it('öffnet ein Dossier per Klick und ist per Tastatur bedienbar', async () => {
    const user = userEvent.setup()
    renderPage()
    const filter = await screen.findByRole('searchbox', { name: 'Nach Namen filtern' })
    filter.focus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getAllByRole('button', { name: /Bachmann, Lea/ })[0]).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getAllByRole('button', { name: /Meier, Anna/ })[0]).toHaveFocus()
    await user.keyboard('{ArrowUp}{ArrowUp}')
    expect(filter).toHaveFocus()
  })

  it('lädt bei dossiers:changed nach', async () => {
    renderPage()
    await screen.findByRole('list', { name: 'Patientendossiers' })
    vi.mocked(window.api.dossiers.list).mockResolvedValue([LIST[0]])
    act(() => emitApiEvent(window.api, 'dossiers.onChanged', { deletedIds: [] }))
    await waitFor(() => expect(rowNames()).toEqual(['Bachmann, Lea']))
  })

  // Lastunabhängig (Abschluss-Check #192): unter CPU-Last streckt jsdom jede
  // absolute Zeit. Geprüft wird deshalb strukturell — Anzeige von 500 Zeilen
  // höchstens linear gegenüber 50 Zeilen (gemessen unmittelbar davor), Filtern
  // nicht teurer als die volle Anzeige, wenige Durchläufe pro Tastendruck —
  // und absolut nur gegen grobe Rückschritte. Die eigentliche Spürbarkeit
  // (AK 15) ist nur in der laufenden App beurteilbar.
  it('zeigt und filtert 500 Dossiers ohne spürbare Verzögerung (AK 15)', async () => {
    const makeMany = (count: number): ReturnType<typeof makeDossierListItem>[] =>
      Array.from({ length: count }, (_, i) =>
        makeDossierListItem({
          id: `d${i}`,
          firstName: `Vorname${i}`,
          lastName: `Nachname${String(i).padStart(3, '0')}`,
          externalId: `PD-${i}`
        })
      )
    let commits = 0
    const timedRender = async (count: number): Promise<{ ms: number; unmount: () => void }> => {
      window.api = createMockApi({
        dossiers: { list: vi.fn().mockResolvedValue(makeMany(count)) }
      })
      const start = performance.now()
      const view = renderWithProviders(
        <Profiler id="dossiers" onRender={() => commits++}>
          <DossiersPage />
        </Profiler>,
        { route: { kind: 'dossiers' } }
      )
      await waitFor(() => expect(rowNames()).toHaveLength(count))
      return { ms: performance.now() - start, unmount: view.unmount }
    }
    ;(await timedRender(50)).unmount() // Aufwärmen
    const small = await timedRender(50)
    small.unmount()
    const large = await timedRender(500)
    expect(large.ms).toBeLessThan(Math.max(25 * small.ms, 250))
    expect(large.ms).toBeLessThan(15_000)

    const filter = screen.getByRole('searchbox', { name: 'Nach Namen filtern' })
    commits = 0
    const filterStart = performance.now()
    fireEvent.change(filter, { target: { value: 'nachname42' } })
    await waitFor(() => expect(rowNames()).toHaveLength(10))
    const filterMs = performance.now() - filterStart
    console.log(
      `[DossiersPage] 50 Zeilen ${small.ms.toFixed(0)} ms, 500 Zeilen ${large.ms.toFixed(0)} ms, Filtern ${filterMs.toFixed(0)} ms`
    )
    expect(filterMs).toBeLessThan(Math.max(large.ms, 250))
    // Ein Tastendruck: Eingabe sofort, gefilterte Liste nachgezogen (useDeferredValue) —
    // höchstens wenige Durchläufe, kein Durchlauf pro Zeile
    expect(commits).toBeLessThanOrEqual(3)
  }, 60_000)
})
