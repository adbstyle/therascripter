import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AnonymizationPanel } from '../AnonymizationPanel'
import type {
  AnonymizationOverviewData,
  AnonymizedIdentity
} from '../../../hooks/useAnonymizationOverview'

beforeEach(() => {
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

function makeIdentity(overrides: Partial<AnonymizedIdentity> = {}): AnonymizedIdentity {
  const variants = overrides.variants ?? [{ text: 'Anna', count: 1, source: 'ner' as const }]
  let canonicalVariant = variants[0]
  let canonicalNonBlocklistVariant: AnonymizedIdentity['canonicalNonBlocklistVariant'] =
    variants[0].source !== 'blocklist' ? variants[0] : null
  let allVariantsBlocklisted = variants[0].source === 'blocklist'
  for (let i = 1; i < variants.length; i++) {
    const v = variants[i]
    if (v.text.length > canonicalVariant.text.length) canonicalVariant = v
    if (v.source !== 'blocklist') {
      allVariantsBlocklisted = false
      if (
        canonicalNonBlocklistVariant === null ||
        v.text.length > canonicalNonBlocklistVariant.text.length
      ) {
        canonicalNonBlocklistVariant = v
      }
    }
  }
  return {
    entityId: 'person-1',
    type: 'PERSON',
    number: 1,
    placeholder: '[PERSON 1]',
    variants,
    totalCount: variants.reduce((sum, v) => sum + v.count, 0),
    canonicalVariant,
    canonicalNonBlocklistVariant,
    allVariantsBlocklisted,
    ...overrides
  }
}

function makeData(identity: AnonymizedIdentity): AnonymizationOverviewData {
  return {
    groups: [{ type: identity.type, label: 'Person', identities: [identity] }],
    totalIdentities: 1,
    totalChips: identity.totalCount
  }
}

function setup(data: AnonymizationOverviewData) {
  const onRevert = vi.fn()
  const onChangeType = vi.fn()
  const onAddToBlocklist = vi.fn()
  const utils = render(
    <AnonymizationPanel
      data={data}
      onRevert={onRevert}
      onChangeType={onChangeType}
      onAddToBlocklist={onAddToBlocklist}
    />
  )
  return { ...utils, onRevert, onChangeType, onAddToBlocklist }
}

describe('AnonymizationPanel', () => {
  it('renders the empty state when no identities exist', () => {
    setup({ groups: [], totalIdentities: 0, totalChips: 0 })
    expect(screen.getByText('Keine Pseudonymisierungen')).toBeInTheDocument()
  })

  it('shows a direct revert button and a separate "more actions" menu trigger', () => {
    setup(makeData(makeIdentity()))
    const revert = screen.getByRole('button', { name: /Pseudonym Person 1 rückgängig machen/ })
    const trigger = screen.getByRole('button', { name: /Weitere Aktionen für Person 1/ })
    expect(revert).toBeInTheDocument()
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('opens a 2-item menu (Typ ändern, Sperrliste) without the revert item', async () => {
    const user = userEvent.setup()
    setup(makeData(makeIdentity()))
    await user.click(screen.getByRole('button', { name: /Weitere Aktionen für Person 1/ }))
    const menu = screen.getByRole('menu', { name: /Aktionen für PERSON 1/i })
    const items = within(menu).getAllByRole('menuitem')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent('Typ ändern')
    expect(items[1]).toHaveTextContent('Zur Sperrliste hinzufügen')
    expect(within(menu).queryByText('Pseudonym rückgängig machen')).toBeNull()
  })

  it('calls onRevert with the entityId when the inline revert button is clicked', async () => {
    const user = userEvent.setup()
    const { onRevert } = setup(makeData(makeIdentity()))
    await user.click(screen.getByRole('button', { name: /Pseudonym Person 1 rückgängig machen/ }))
    expect(onRevert).toHaveBeenCalledWith('person-1')
  })

  it('the inline revert button does not open the popover', async () => {
    const user = userEvent.setup()
    setup(makeData(makeIdentity()))
    await user.click(screen.getByRole('button', { name: /Pseudonym Person 1 rückgängig machen/ }))
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('calls onChangeType with the new type when a "Typ ändern" option is picked', async () => {
    const user = userEvent.setup()
    const { onChangeType } = setup(makeData(makeIdentity()))
    await user.click(screen.getByRole('button', { name: /Weitere Aktionen für Person 1/ }))
    await user.click(screen.getByRole('menuitem', { name: /Typ ändern/ }))
    await user.click(screen.getByRole('menuitem', { name: /^Ort$/ }))
    expect(onChangeType).toHaveBeenCalledWith('person-1', 'ORT')
  })

  it('calls onAddToBlocklist using the longest variant as canonical text', async () => {
    const user = userEvent.setup()
    const identity = makeIdentity({
      variants: [
        { text: 'Müller', count: 2, source: 'ner' },
        { text: 'Hans Müller', count: 1, source: 'ner' },
        { text: 'Hans', count: 1, source: 'ner' }
      ],
      totalCount: 4
    })
    const { onAddToBlocklist } = setup(makeData(identity))

    await user.click(screen.getByRole('button', { name: /Weitere Aktionen für Person 1/ }))
    await user.click(screen.getByRole('menuitem', { name: /Zur Sperrliste hinzufügen/ }))
    await user.click(screen.getByRole('menuitem', { name: /^Person$/ }))

    expect(onAddToBlocklist).toHaveBeenCalledWith('person-1', 'Hans Müller', 'PERSON')
  })

  it('disables "Zur Sperrliste hinzufügen" only when ALL variants are blocklisted (AC6)', async () => {
    const user = userEvent.setup()
    const identity = makeIdentity({
      variants: [
        { text: 'Müller', count: 1, source: 'blocklist' },
        { text: 'Hans Müller', count: 2, source: 'blocklist' }
      ],
      totalCount: 3
    })
    setup(makeData(identity))

    await user.click(screen.getByRole('button', { name: /Weitere Aktionen für Person 1/ }))
    const item = screen.getByRole('menuitem', { name: /Zur Sperrliste hinzufügen/ })
    expect(item).toHaveAttribute('aria-disabled', 'true')
    expect(within(item).getByText('Bereits in Sperrliste')).toBeInTheDocument()
  })

  it('keeps "Zur Sperrliste hinzufügen" enabled for a mixed-source identity', async () => {
    const user = userEvent.setup()
    const identity = makeIdentity({
      variants: [
        { text: 'Müller', count: 1, source: 'ner' },
        { text: 'Hans Müller', count: 2, source: 'blocklist' }
      ],
      totalCount: 3
    })
    setup(makeData(identity))

    await user.click(screen.getByRole('button', { name: /Weitere Aktionen für Person 1/ }))
    const item = screen.getByRole('menuitem', { name: /Zur Sperrliste hinzufügen/ })
    expect(item).not.toHaveAttribute('aria-disabled', 'true')
    expect(within(item).queryByText('Bereits in Sperrliste')).toBeNull()
  })

  it('uses the non-blocklist canonical variant when adding a mixed-source identity', async () => {
    const user = userEvent.setup()
    const identity = makeIdentity({
      variants: [
        { text: 'Müller', count: 1, source: 'ner' },
        { text: 'Hans Müller', count: 2, source: 'blocklist' }
      ],
      totalCount: 3
    })
    const { onAddToBlocklist } = setup(makeData(identity))

    await user.click(screen.getByRole('button', { name: /Weitere Aktionen für Person 1/ }))
    await user.click(screen.getByRole('menuitem', { name: /Zur Sperrliste hinzufügen/ }))
    await user.click(screen.getByRole('menuitem', { name: /^Person$/ }))

    // Müller is the only non-blocklist variant — used as the term so we don't
    // duplicate the existing "Hans Müller" Sperrliste row.
    expect(onAddToBlocklist).toHaveBeenCalledWith('person-1', 'Müller', 'PERSON')
  })

  it('reflects the menu open state on the trigger via aria-expanded', async () => {
    const user = userEvent.setup()
    setup(makeData(makeIdentity()))
    const trigger = screen.getByRole('button', { name: /Weitere Aktionen für Person 1/ })
    await user.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
  })

  it('returns focus to the trigger after Escape (dismissed close)', async () => {
    const user = userEvent.setup()
    setup(makeData(makeIdentity()))
    const trigger = screen.getByRole('button', { name: /Weitere Aktionen für Person 1/ })
    await user.click(trigger)
    await user.keyboard('{Escape}')
    expect(trigger).toHaveFocus()
  })

  it('does NOT refocus the trigger after activating an action (lets the editor own focus)', async () => {
    const user = userEvent.setup()
    const { onChangeType } = setup(makeData(makeIdentity()))
    const trigger = screen.getByRole('button', { name: /Weitere Aktionen für Person 1/ })
    /*
     * Park focus somewhere neutral before the action — simulates the editor
     * having focus when the host's action handler fires editor.commands.focus().
     * If closeMenu refocused the trigger on activation it would steal focus
     * back from this neutral element.
     */
    document.body.focus()
    await user.click(trigger)
    await user.click(screen.getByRole('menuitem', { name: /Typ ändern/ }))
    await user.click(screen.getByRole('menuitem', { name: /^Ort$/ }))
    expect(onChangeType).toHaveBeenCalledWith('person-1', 'ORT')
    expect(trigger).not.toHaveFocus()
  })

  it('shows variant text and per-variant source label', () => {
    const identity = makeIdentity({
      variants: [
        { text: 'Müller', count: 2, source: 'ner' },
        { text: 'Hans Müller', count: 1, source: 'blocklist' }
      ],
      totalCount: 3
    })
    setup(makeData(identity))

    expect(screen.getByText(/“Müller”/)).toBeInTheDocument()
    expect(screen.getByText(/“Hans Müller”/)).toBeInTheDocument()
    expect(screen.getByLabelText('Automatisch erkannt (NER)')).toBeInTheDocument()
    expect(screen.getByLabelText('Sperrliste')).toBeInTheDocument()
  })
})
