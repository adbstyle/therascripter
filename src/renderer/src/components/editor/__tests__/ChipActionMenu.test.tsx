import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChipActionMenu } from '../ChipActionMenu'
import type { EntitySource, PlaceholderType } from '../../../../../shared/types'

interface SetupOpts {
  source?: EntitySource
  count?: number
  type?: PlaceholderType
  number?: number
}

function setup(opts: SetupOpts = {}) {
  const onUndo = vi.fn()
  const onChangeType = vi.fn()
  const onAddToBlocklist = vi.fn()
  const onClose = vi.fn()
  const anchorRect = new DOMRect(200, 200, 80, 22)

  const utils = render(
    <ChipActionMenu
      anchorRect={anchorRect}
      entityId="person-1"
      entityType={opts.type ?? 'PERSON'}
      entityNumber={opts.number ?? 1}
      entitySource={opts.source ?? 'ner'}
      original="Anna"
      occurrenceCount={opts.count ?? 3}
      onUndo={onUndo}
      onChangeType={onChangeType}
      onAddToBlocklist={onAddToBlocklist}
      onClose={onClose}
    />
  )

  return { ...utils, onUndo, onChangeType, onAddToBlocklist, onClose }
}

beforeEach(() => {
  // jsdom getBoundingClientRect returns zeros — give the layout effect numbers
  // it can use so positioning code does not bail out.
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value() {
      return {
        x: 100,
        y: 100,
        width: 240,
        height: 120,
        top: 100,
        left: 100,
        right: 340,
        bottom: 220,
        toJSON() {}
      }
    }
  })
})

describe('ChipActionMenu', () => {
  it('renders three primary menu items with correct ARIA roles', () => {
    setup()
    const menu = screen.getByRole('menu', { name: /Aktionen für PERSON 1/i })
    expect(menu).toHaveAttribute('aria-orientation', 'vertical')

    const items = within(menu).getAllByRole('menuitem')
    expect(items).toHaveLength(3)
    expect(items[0]).toHaveTextContent('Pseudonym entfernen')
    expect(items[1]).toHaveTextContent('Typ ändern')
    expect(items[1]).toHaveAttribute('aria-haspopup', 'menu')
    expect(items[2]).toHaveTextContent('Zur Sperrliste hinzufügen')
    expect(items[2]).toHaveAttribute('aria-haspopup', 'menu')
  })

  it('shows the original text + occurrence count in the supporting line when > 1', () => {
    setup({ count: 3 })
    expect(screen.getByText('»Anna« · 3 Vorkommen')).toBeInTheDocument()
  })

  it('shows only the original text when count is 1', () => {
    setup({ count: 1 })
    expect(screen.getByText('»Anna«')).toBeInTheDocument()
  })

  it('disables "Zur Sperrliste hinzufügen" when source is blocklist', () => {
    setup({ source: 'blocklist' })
    const item = screen.getByRole('menuitem', { name: /Zur Sperrliste hinzufügen/ })
    expect(item).toHaveAttribute('aria-disabled', 'true')
    expect(item).toBeDisabled()
    expect(within(item).getByText('Bereits in Sperrliste')).toBeInTheDocument()
  })

  it('clicking "Pseudonym entfernen" calls onUndo with entityId and closes', async () => {
    const user = userEvent.setup()
    const { onUndo, onClose } = setup()
    await user.click(screen.getByRole('menuitem', { name: /Pseudonym entfernen/ }))
    expect(onUndo).toHaveBeenCalledWith('person-1')
    expect(onClose).toHaveBeenCalled()
  })

  it('"Typ ändern" submenu omits the current type (PERSON → 4 options)', async () => {
    const user = userEvent.setup()
    setup({ type: 'PERSON' })
    await user.click(screen.getByRole('menuitem', { name: /Typ ändern/ }))

    const submenu = screen.getByRole('menu', { name: /Typ ändern/i })
    const subItems = within(submenu).getAllByRole('menuitem')
    expect(subItems).toHaveLength(4)
    expect(subItems.map((b) => b.textContent)).toEqual([
      'Ort',
      'Datum',
      'Kontakt',
      'Organisation'
    ])
  })

  it('"Typ ändern" submenu omits the current type (ORGANISATION → 4 options)', async () => {
    const user = userEvent.setup()
    setup({ type: 'ORGANISATION' })
    await user.click(screen.getByRole('menuitem', { name: /Typ ändern/ }))

    const subItems = within(screen.getByRole('menu', { name: /Typ ändern/i })).getAllByRole(
      'menuitem'
    )
    expect(subItems.map((b) => b.textContent)).toEqual([
      'Person',
      'Ort',
      'Datum',
      'Kontakt'
    ])
  })

  it('clicking a "Typ ändern" submenu item calls onChangeType + onClose', async () => {
    const user = userEvent.setup()
    const { onChangeType, onClose } = setup({ type: 'PERSON' })
    await user.click(screen.getByRole('menuitem', { name: /Typ ändern/ }))
    await user.click(screen.getByRole('menuitem', { name: /^Ort$/ }))
    expect(onChangeType).toHaveBeenCalledWith('person-1', 'ORT')
    expect(onClose).toHaveBeenCalled()
  })

  it('"Zur Sperrliste hinzufügen" submenu lists all 7 types', async () => {
    const user = userEvent.setup()
    setup()
    await user.click(screen.getByRole('menuitem', { name: /Zur Sperrliste hinzufügen/ }))
    const submenu = screen.getByRole('menu', { name: /Zur Sperrliste hinzufügen/i })
    const subItems = within(submenu).getAllByRole('menuitem')
    expect(subItems).toHaveLength(7)
    expect(subItems.map((b) => b.textContent)).toEqual([
      'Person',
      'Ort',
      'Datum',
      'Kontakt',
      'Organisation',
      'Medizinisch',
      'Sonstiges'
    ])
  })

  it('clicking a "Zur Sperrliste hinzufügen" submenu item calls onAddToBlocklist with original + type', async () => {
    const user = userEvent.setup()
    const { onAddToBlocklist, onClose } = setup()
    await user.click(screen.getByRole('menuitem', { name: /Zur Sperrliste hinzufügen/ }))
    await user.click(screen.getByRole('menuitem', { name: /Medizinisch/ }))
    expect(onAddToBlocklist).toHaveBeenCalledWith('person-1', 'Anna', 'MEDIZINISCH')
    expect(onClose).toHaveBeenCalled()
  })

  it('Esc on top-level closes the menu (calls onClose)', async () => {
    const user = userEvent.setup()
    const { onClose } = setup()
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalled()
  })

  it('Esc inside submenu collapses to main level WITHOUT closing', async () => {
    const user = userEvent.setup()
    const { onClose } = setup()
    await user.click(screen.getByRole('menuitem', { name: /Typ ändern/ }))
    expect(screen.getByRole('menu', { name: /Typ ändern/i })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu', { name: /Typ ändern/i })).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('ArrowRight on focused submenu trigger opens its submenu', async () => {
    const user = userEvent.setup()
    setup()
    // mainFocus starts at 0 → "Pseudonym entfernen". Move down to "Typ ändern".
    await user.keyboard('{ArrowDown}{ArrowRight}')
    expect(screen.getByRole('menu', { name: /Typ ändern/i })).toBeInTheDocument()
  })

  it('ArrowDown then Enter on first item activates "Pseudonym entfernen"', async () => {
    const user = userEvent.setup()
    const { onUndo } = setup()
    await user.keyboard('{Enter}')
    expect(onUndo).toHaveBeenCalledWith('person-1')
  })

  it('ArrowDown skips disabled "Zur Sperrliste" item when source=blocklist', async () => {
    const user = userEvent.setup()
    const { onUndo } = setup({ source: 'blocklist', type: 'PERSON' })
    // mainFocus starts at 0 (Pseudonym entfernen). Two ArrowDowns: first → 1 (Typ
    // ändern), second skips idx 2 (disabled Sperrliste) and wraps back to 0.
    // Enter on idx 0 fires onUndo.
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}')
    expect(onUndo).toHaveBeenCalledWith('person-1')
  })
})
