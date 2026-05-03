import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PlaceholderChipView } from '../PlaceholderChipView'
import { ChipActionsContext, type ChipActions } from '../../../contexts/ChipActionsContext'
import type { EntitySource, PlaceholderType } from '../../../../../shared/types'

interface MockNodeViewWrapperProps {
  children?: React.ReactNode
  as?: React.ElementType
  className?: string
}

// Tiptap's NodeViewWrapper relies on context from the editor. For unit tests
// we replace it with a passthrough.
vi.mock('@tiptap/react', () => ({
  NodeViewWrapper: ({ children, as: As = 'span', className }: MockNodeViewWrapperProps) => (
    <As className={className}>{children}</As>
  )
}))

interface SetupOpts {
  source?: EntitySource
  type?: PlaceholderType
  number?: number
  selected?: boolean
  occurrenceCount?: number
  withActions?: boolean
}

function setup(opts: SetupOpts = {}) {
  const node = {
    attrs: {
      entityId: 'person-1',
      type: opts.type ?? 'PERSON',
      number: opts.number ?? 1,
      source: opts.source ?? 'ner',
      original: 'Anna'
    }
  }
  const props = { node, selected: opts.selected ?? false } as unknown as Parameters<
    typeof PlaceholderChipView
  >[0]

  const actions: ChipActions = {
    onUndo: vi.fn(),
    onChangeType: vi.fn(),
    onAddToBlocklist: vi.fn(),
    getOccurrenceCount: vi.fn(() => opts.occurrenceCount ?? 1)
  }

  const utils = render(
    opts.withActions === false ? (
      <PlaceholderChipView {...props} />
    ) : (
      <ChipActionsContext.Provider value={actions}>
        <PlaceholderChipView {...props} />
      </ChipActionsContext.Provider>
    )
  )

  return { ...utils, actions }
}

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value() {
      return {
        x: 100,
        y: 100,
        width: 80,
        height: 22,
        top: 100,
        left: 100,
        right: 180,
        bottom: 122,
        toJSON() {}
      }
    }
  })
})

describe('PlaceholderChipView', () => {
  it('renders as a button with type-specific aria-label including source', () => {
    setup({ type: 'PERSON', number: 1, source: 'ner' })
    const chip = screen.getByRole('button', { name: /Person 1, Automatisch erkannt/i })
    expect(chip).toHaveAttribute('aria-haspopup', 'menu')
    expect(chip).toHaveAttribute('aria-expanded', 'false')
    expect(chip).toHaveAttribute('tabindex', '0')
  })

  it('uses Sperrliste source label when source=blocklist', () => {
    setup({ source: 'blocklist' })
    expect(
      screen.getByRole('button', { name: /Person 1, Sperrliste/i })
    ).toBeInTheDocument()
  })

  it('uses manuell-markiert label when source=manual', () => {
    setup({ source: 'manual' })
    expect(
      screen.getByRole('button', { name: /Person 1, Manuell markiert/i })
    ).toBeInTheDocument()
  })

  it('opens action menu on click and flips aria-expanded', async () => {
    const user = userEvent.setup()
    setup()
    const chip = screen.getByRole('button', { name: /Person 1/ })
    expect(screen.queryByRole('menu')).toBeNull()

    await user.click(chip)
    expect(chip).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('menu', { name: /Aktionen für PERSON 1/i })).toBeInTheDocument()
  })

  it('opens action menu on Enter key', async () => {
    const user = userEvent.setup()
    setup()
    const chip = screen.getByRole('button', { name: /Person 1/ })
    chip.focus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('opens action menu on Space key', async () => {
    const user = userEvent.setup()
    setup()
    const chip = screen.getByRole('button', { name: /Person 1/ })
    chip.focus()
    await user.keyboard(' ')
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('Escape closes the menu and chip aria-expanded returns to false', async () => {
    const user = userEvent.setup()
    setup()
    const chip = screen.getByRole('button', { name: /Person 1/ })
    await user.click(chip)
    expect(chip).toHaveAttribute('aria-expanded', 'true')

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(chip).toHaveAttribute('aria-expanded', 'false')
  })

  it('passes occurrence count from context into the menu supporting text', async () => {
    const user = userEvent.setup()
    setup({ occurrenceCount: 4 })
    await user.click(screen.getByRole('button', { name: /Person 1/ }))
    expect(screen.getByText(/Hebt 4 Vorkommen PERSON 1 auf/)).toBeInTheDocument()
  })

  it('right-click on chip is suppressed (no editor context menu, AK 13)', () => {
    setup()
    const chip = screen.getByRole('button', { name: /Person 1/ })
    const result = fireEvent.contextMenu(chip)
    // fireEvent returns false when defaultPrevented was set on the dispatched event.
    expect(result).toBe(false)
  })

  it('shows tooltip with original text on focus and hides it when menu opens', async () => {
    const user = userEvent.setup()
    setup()
    const chip = screen.getByRole('button', { name: /Person 1/ })

    fireEvent.focus(chip)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Anna')

    await user.click(chip)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('renders chip with no actions context — clicking does NOT throw and menu does not open', async () => {
    const user = userEvent.setup()
    setup({ withActions: false })
    const chip = screen.getByRole('button', { name: /Person 1/ })
    await user.click(chip)
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
