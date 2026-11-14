import { describe, it, expect, beforeEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NavigationProvider } from '../NavigationContext'
import { useNavigation } from '../navigation'
import { routeKey } from '../routes'
import { createMockApi, emitApiEvent } from '../../test/mockApi'

function Probe(): React.JSX.Element {
  const nav = useNavigation()
  return (
    <div>
      <p data-testid="route">{routeKey(nav.route)}</p>
      <p data-testid="can">{`${nav.canBack}/${nav.canForward}`}</p>
      <button onClick={() => nav.navigate({ kind: 'session', sessionId: 'a' })}>A</button>
      <button onClick={() => nav.navigate({ kind: 'session', sessionId: 'b' })}>B</button>
      <button onClick={() => nav.navigate({ kind: 'dossier', dossierId: 'd1' })}>D1</button>
    </div>
  )
}

const route = (): string => screen.getByTestId('route').textContent ?? ''

beforeEach(() => {
  window.api = createMockApi()
})

describe('NavigationProvider', () => {
  it('folgt den Menübefehlen «Zurück» und «Vorwärts» (nav:command)', async () => {
    render(
      <NavigationProvider>
        <Probe />
      </NavigationProvider>
    )
    await userEvent.click(screen.getByText('A'))
    expect(route()).toBe('session:a')
    expect(screen.getByTestId('can').textContent).toBe('true/false')

    act(() => emitApiEvent(window.api, 'nav.onCommand', 'back'))
    expect(route()).toBe('sessions')
    expect(screen.getByTestId('can').textContent).toBe('false/true')

    act(() => emitApiEvent(window.api, 'nav.onCommand', 'forward'))
    expect(route()).toBe('session:a')
  })

  it('ignoriert «Seitenleiste» — die Shell schaltet sie selbst', () => {
    render(
      <NavigationProvider>
        <Probe />
      </NavigationProvider>
    )
    act(() => emitApiEvent(window.api, 'nav.onCommand', 'toggleSidebar'))
    expect(route()).toBe('sessions')
  })

  it('öffnet die Einstellungen aus App-Menü und Tray (nav:openSettings)', () => {
    render(
      <NavigationProvider initialRoute={{ kind: 'settings', subpage: 'updates' }}>
        <Probe />
      </NavigationProvider>
    )
    act(() => emitApiEvent(window.api, 'nav.onOpenSettings'))
    expect(route()).toBe('settings:')
  })

  it('entfernt gelöschte Sitzungen aus dem Verlauf (sessions:changed, #213 PC 3)', async () => {
    render(
      <NavigationProvider>
        <Probe />
      </NavigationProvider>
    )
    await userEvent.click(screen.getByText('A'))
    await userEvent.click(screen.getByText('B'))

    act(() => emitApiEvent(window.api, 'sessions.onChanged', { deletedIds: ['b'] }))
    expect(route()).toBe('session:a')

    act(() => emitApiEvent(window.api, 'sessions.onChanged', { deletedIds: ['a'] }))
    expect(route()).toBe('sessions')
    expect(screen.getByTestId('can').textContent).toBe('false/false')
  })

  it('entfernt gelöschte Dossiers aus dem Verlauf, die aktuelle Seite wird die Übersicht (dossiers:changed)', async () => {
    render(
      <NavigationProvider>
        <Probe />
      </NavigationProvider>
    )
    await userEvent.click(screen.getByText('D1'))
    await userEvent.click(screen.getByText('A'))
    await userEvent.click(screen.getByText('D1'))
    expect(route()).toBe('dossier:d1')

    act(() => emitApiEvent(window.api, 'dossiers.onChanged', { deletedIds: ['d1'] }))
    expect(route()).toBe('dossiers')
    // Zurück führt nicht mehr ins gelöschte Dossier
    act(() => emitApiEvent(window.api, 'nav.onCommand', 'back'))
    expect(route()).toBe('session:a')
    act(() => emitApiEvent(window.api, 'nav.onCommand', 'back'))
    expect(route()).toBe('sessions')
    expect(screen.getByTestId('can').textContent).toBe('false/true')
  })

  it('lässt den Verlauf bei Änderungen ohne Löschung unverändert', async () => {
    render(
      <NavigationProvider>
        <Probe />
      </NavigationProvider>
    )
    await userEvent.click(screen.getByText('A'))
    act(() => emitApiEvent(window.api, 'sessions.onChanged', { deletedIds: [] }))
    expect(route()).toBe('session:a')
    expect(screen.getByTestId('can').textContent).toBe('true/false')
  })
})
