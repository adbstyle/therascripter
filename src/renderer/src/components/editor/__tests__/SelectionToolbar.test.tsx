import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SelectionToolbar } from '../SelectionToolbar'

interface SetupOpts {
  multiChipSelectionOnly?: boolean
}

function setup(opts: SetupOpts = {}) {
  const onAnonymize = vi.fn()
  const onAddToBlocklist = vi.fn()
  const onClose = vi.fn()
  const anchorRect = new DOMRect(200, 200, 80, 22)

  const utils = render(
    <SelectionToolbar
      anchorRect={anchorRect}
      multiChipSelectionOnly={opts.multiChipSelectionOnly ?? false}
      onAnonymize={onAnonymize}
      onAddToBlocklist={onAddToBlocklist}
      onClose={onClose}
    />
  )

  return { ...utils, onAnonymize, onAddToBlocklist, onClose }
}

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value() {
      return {
        x: 100,
        y: 100,
        width: 240,
        height: 100,
        top: 100,
        left: 100,
        right: 340,
        bottom: 200,
        toJSON() {}
      }
    }
  })
})

describe('SelectionToolbar', () => {
  it('renders two submenu triggers labelled "Pseudonymisieren" and "Auf Sperrliste setzen"', () => {
    setup()
    const menu = screen.getByRole('menu', { name: /Aktionen für die aktuelle Auswahl/i })
    const items = within(menu).getAllByRole('menuitem')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent('Pseudonymisieren')
    expect(items[0]).toHaveAttribute('aria-haspopup', 'menu')
    expect(items[1]).toHaveTextContent('Auf Sperrliste setzen')
    expect(items[1]).toHaveAttribute('aria-haspopup', 'menu')
  })

  it('"Pseudonymisieren" submenu lists 5 type options and routes onSelect', async () => {
    const user = userEvent.setup()
    const { onAnonymize, onClose } = setup()
    await user.click(screen.getByRole('menuitem', { name: /Pseudonymisieren/ }))

    const submenu = screen.getByRole('menu', { name: /Pseudonymisieren/i })
    const subItems = within(submenu).getAllByRole('menuitem')
    expect(subItems.map((b) => b.textContent)).toEqual([
      'Person',
      'Ort',
      'Datum',
      'Kontakt',
      'Organisation'
    ])

    await user.click(within(submenu).getByRole('menuitem', { name: /Datum/ }))
    expect(onAnonymize).toHaveBeenCalledWith('DATUM')
    expect(onClose).toHaveBeenCalled()
  })

  it('"Auf Sperrliste setzen" submenu lists 7 type options and routes onSelect', async () => {
    const user = userEvent.setup()
    const { onAddToBlocklist, onClose } = setup()
    await user.click(screen.getByRole('menuitem', { name: /Auf Sperrliste setzen/ }))

    const submenu = screen.getByRole('menu', { name: /Auf Sperrliste setzen/i })
    const subItems = within(submenu).getAllByRole('menuitem')
    expect(subItems).toHaveLength(7)

    await user.click(within(submenu).getByRole('menuitem', { name: /Medizinisch/ }))
    expect(onAddToBlocklist).toHaveBeenCalledWith('MEDIZINISCH')
    expect(onClose).toHaveBeenCalled()
  })

  it('disables both actions with a hint when multiChipSelectionOnly is true', () => {
    setup({ multiChipSelectionOnly: true })
    const items = screen.getAllByRole('menuitem')
    expect(items.every((it) => it.getAttribute('aria-disabled') === 'true')).toBe(true)
    expect(items.every((it) => it.hasAttribute('disabled'))).toBe(true)
    expect(screen.getAllByText(/Mehrere Chips/i).length).toBeGreaterThanOrEqual(2)
  })

  it('Esc closes the toolbar', async () => {
    const user = userEvent.setup()
    const { onClose } = setup()
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalled()
  })

  it('Esc does not bubble past the popover (regression: stopPropagation)', async () => {
    const user = userEvent.setup()
    const windowListener = vi.fn()
    window.addEventListener('keydown', windowListener)
    try {
      setup()
      await user.keyboard('{Escape}')
      // ReviewEditor wires a window-level Escape listener that calls onBack().
      // The popover must consume Escape so it never reaches the window.
      expect(windowListener).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', windowListener)
    }
  })
})
