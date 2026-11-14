import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'

const buildFromTemplate = vi.fn((template: MenuItemConstructorOptions[]) => template)
vi.mock('electron', () => ({
  app: { getName: () => 'Therascript', isPackaged: true },
  Menu: {
    buildFromTemplate: (t: MenuItemConstructorOptions[]) => buildFromTemplate(t),
    setApplicationMenu: vi.fn()
  }
}))

import { initAppMenu } from '../AppMenuService'

function findItem(label: string): MenuItemConstructorOptions {
  const template = buildFromTemplate.mock.calls.at(-1)![0]
  for (const menu of template) {
    for (const item of (menu.submenu as MenuItemConstructorOptions[]) ?? []) {
      if (item.label === label) return item
    }
  }
  throw new Error(`Menüpunkt ${label} fehlt`)
}

describe('AppMenuService — «Gehe zu» (Epic #192)', () => {
  const platform = process.platform
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    buildFromTemplate.mockClear()
    return () => Object.defineProperty(process, 'platform', { value: platform })
  })

  it('sendet «Suchen …» (⌘K) als nav:command search (#209)', () => {
    const onNavCommand = vi.fn()
    const onShowWindow = vi.fn()
    initAppMenu({ onOpenSettings: vi.fn(), onNavCommand, onShowWindow })
    const search = findItem('Suchen …')
    expect(search.accelerator).toBe('Command+K')
    ;(search.click as () => void)()
    expect(onNavCommand.mock.calls).toEqual([['search']])
    // Verstecktes Fenster zuerst zeigen
    expect(onShowWindow).toHaveBeenCalledTimes(1)
    expect(onShowWindow.mock.invocationCallOrder[0]).toBeLessThan(
      onNavCommand.mock.invocationCallOrder[0]
    )
  })

  it('sendet Zurück (⌘[), Vorwärts (⌘]) und Seitenleiste (⌃⌘S) als nav:command', () => {
    const onNavCommand = vi.fn()
    initAppMenu({ onOpenSettings: vi.fn(), onNavCommand })

    const template = buildFromTemplate.mock.calls.at(-1)![0]
    expect(template.map((m) => m.label)).toContain('Gehe zu')

    const back = findItem('Zurück')
    const forward = findItem('Vorwärts')
    const sidebar = findItem('Seitenleiste ein-/ausblenden')
    expect(back.accelerator).toBe('Command+[')
    expect(forward.accelerator).toBe('Command+]')
    expect(sidebar.accelerator).toBe('Control+Command+S')

    const click = (item: MenuItemConstructorOptions): void => (item.click as () => void)()
    click(back)
    click(forward)
    click(sidebar)
    expect(onNavCommand.mock.calls).toEqual([['back'], ['forward'], ['toggleSidebar']])
  })
})
