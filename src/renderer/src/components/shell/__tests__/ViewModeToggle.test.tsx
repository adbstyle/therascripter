import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import TitleBar from '../TitleBar'
import { NavigationProvider } from '../../../navigation/NavigationContext'
import { createMockApi } from '../../../test/mockApi'
import { getViewMode, _resetViewModeStoreForTests } from '../../../viewMode/viewModeStore'

function renderWith(initial: string) {
  const set = vi.fn().mockResolvedValue(undefined)
  window.api = createMockApi({
    viewMode: { initial, set } as unknown as typeof window.api.viewMode
  })
  _resetViewModeStoreForTests()
  render(
    <NavigationProvider>
      <TitleBar />
    </NavigationProvider>
  )
  return set
}

/** Issue #203 AK 1, AK 2 — the view switch in the title bar, present in every view of the app. */
describe('ViewModeToggle', () => {
  afterEach(() => _resetViewModeStoreForTests())

  it('names both views and marks the active one', () => {
    renderWith('pseudonymized')
    const group = screen.getByRole('group', { name: 'Ansicht' })
    expect(group).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Pseudonymisiert' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByRole('button', { name: 'Klartext' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
  })

  it('switches by click and saves the choice', async () => {
    const set = renderWith('pseudonymized')
    await userEvent.click(screen.getByRole('button', { name: 'Klartext' }))
    expect(getViewMode()).toBe('plain')
    expect(set).toHaveBeenCalledWith('plain')
    expect(screen.getByRole('button', { name: 'Klartext' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('is operable by keyboard', async () => {
    renderWith('plain')
    const user = userEvent.setup()
    // Erst der Seitenleisten-Knopf; ‹ › sind ohne Verlauf deaktiviert (Epic #192)
    await user.tab()
    expect(screen.getByRole('button', { name: 'Seitenleiste' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Pseudonymisiert' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(getViewMode()).toBe('pseudonymized')
  })

  it('stays clickable inside the window drag region', () => {
    renderWith('pseudonymized')
    expect(screen.getByRole('group', { name: 'Ansicht' })).toHaveClass('titlebar-no-drag')
  })
})
