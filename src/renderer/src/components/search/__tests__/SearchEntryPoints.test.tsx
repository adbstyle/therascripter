import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Sidebar from '../../shell/Sidebar'
import { SearchHost } from '../SearchHost'
import { DossierHeaderActions } from '../../dossier/DossierHeaderActions'
import { renderWithProviders } from '../../../test/renderWithProviders'
import { createMockApi } from '../../../test/mockApi'
import { useNavigation } from '../../../navigation/navigation'
import { _resetSearchSessionForTests } from '../../../stores/searchSession'

/** Einstiege in die Suche: «Suchen ⌘K» in der Seitenleiste (#209), «Im Dossier suchen» (#211). */

function RouteProbe(): React.JSX.Element {
  const { route } = useNavigation()
  return <p data-testid="route">{JSON.stringify(route)}</p>
}

beforeEach(() => {
  _resetSearchSessionForTests()
  window.api = createMockApi()
})
afterEach(() => _resetSearchSessionForTests())

describe('Einstiege in die Suche', () => {
  it('«Suchen ⌘K» in der Seitenleiste öffnet das Suchfenster', async () => {
    renderWithProviders(
      <>
        <Sidebar />
        <SearchHost />
      </>
    )
    const entry = screen.getByRole('button', { name: /Suchen/ })
    expect(entry).toHaveTextContent('⌘K')
    await userEvent.click(entry)
    expect(
      await screen.findByRole('dialog', { name: 'Patientendossiers und Inhalte durchsuchen' })
    ).toBeTruthy()
  })

  it('«Im Dossier suchen» öffnet die Suche dieses Dossiers', async () => {
    renderWithProviders(
      <>
        <RouteProbe />
        <DossierHeaderActions dossierId="d1" dossierName="Hofer, Lukas" />
      </>,
      { route: { kind: 'dossier', dossierId: 'd1' } }
    )
    await userEvent.click(screen.getByRole('button', { name: 'Im Dossier suchen' }))
    expect(JSON.parse(screen.getByTestId('route').textContent!)).toEqual({
      kind: 'dossierSearch',
      dossierId: 'd1'
    })
  })
})
