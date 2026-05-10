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
  for (let i = 1; i < variants.length; i++) {
    if (variants[i].text.length > canonicalVariant.text.length) canonicalVariant = variants[i]
  }
  return {
    entityId: 'person-1',
    type: 'PERSON',
    number: 1,
    placeholder: '[PERSON 1]',
    variants,
    totalCount: variants.reduce((sum, v) => sum + v.count, 0),
    canonicalVariant,
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

  it('shows an action-menu trigger per identity, labeled with the placeholder', () => {
    setup(makeData(makeIdentity()))
    const trigger = screen.getByRole('button', { name: /Aktionen für Person 1/ })
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('opens the action menu when the trigger is clicked', async () => {
    const user = userEvent.setup()
    setup(makeData(makeIdentity()))
    await user.click(screen.getByRole('button', { name: /Aktionen für Person 1/ }))
    expect(screen.getByRole('menu', { name: /Aktionen für PERSON 1/i })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /Pseudonym entfernen/ })).toBeInTheDocument()
  })

  it('calls onRevert with the entityId when "Pseudonym entfernen" is activated', async () => {
    const user = userEvent.setup()
    const { onRevert } = setup(makeData(makeIdentity()))
    await user.click(screen.getByRole('button', { name: /Aktionen für Person 1/ }))
    await user.click(screen.getByRole('menuitem', { name: /Pseudonym entfernen/ }))
    expect(onRevert).toHaveBeenCalledWith('person-1')
  })

  it('calls onChangeType with the new type when a "Typ ändern" option is picked', async () => {
    const user = userEvent.setup()
    const { onChangeType } = setup(makeData(makeIdentity()))
    await user.click(screen.getByRole('button', { name: /Aktionen für Person 1/ }))
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

    await user.click(screen.getByRole('button', { name: /Aktionen für Person 1/ }))
    await user.click(screen.getByRole('menuitem', { name: /Zur Sperrliste hinzufügen/ }))
    await user.click(screen.getByRole('menuitem', { name: /^Person$/ }))

    expect(onAddToBlocklist).toHaveBeenCalledWith('person-1', 'Hans Müller', 'PERSON')
  })

  it('disables "Zur Sperrliste hinzufügen" when any variant comes from the blocklist (AC6)', async () => {
    const user = userEvent.setup()
    const identity = makeIdentity({
      variants: [
        { text: 'Müller', count: 1, source: 'ner' },
        { text: 'Hans Müller', count: 2, source: 'blocklist' }
      ],
      totalCount: 3
    })
    setup(makeData(identity))

    await user.click(screen.getByRole('button', { name: /Aktionen für Person 1/ }))
    const item = screen.getByRole('menuitem', { name: /Zur Sperrliste hinzufügen/ })
    expect(item).toHaveAttribute('aria-disabled', 'true')
    expect(within(item).getByText('Bereits in Sperrliste')).toBeInTheDocument()
  })

  it('reflects the menu open state on the trigger via aria-expanded', async () => {
    const user = userEvent.setup()
    setup(makeData(makeIdentity()))
    const trigger = screen.getByRole('button', { name: /Aktionen für Person 1/ })
    await user.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
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
