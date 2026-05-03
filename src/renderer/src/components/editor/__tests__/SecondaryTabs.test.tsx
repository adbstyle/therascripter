import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SecondaryTabs } from '../SecondaryTabs'

const TABS = [
  { id: 'a' as const, label: 'Alpha', badge: 7 },
  { id: 'b' as const, label: 'Bravo' }
]

function setup(activeId: 'a' | 'b' = 'a') {
  const onChange = vi.fn()
  render(
    <SecondaryTabs
      tabs={TABS}
      activeId={activeId}
      onChange={onChange}
      ariaLabel="Test tabs"
      idPrefix="t"
    />
  )
  return { onChange }
}

describe('SecondaryTabs', () => {
  it('exposes a tablist with one tab per entry and the correct selected state', () => {
    setup('a')
    const tablist = screen.getByRole('tablist', { name: 'Test tabs' })
    expect(tablist).toBeInTheDocument()

    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(2)
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
    expect(tabs[1]).toHaveAttribute('aria-selected', 'false')

    expect(tabs[0]).toHaveAttribute('aria-controls', 't-panel-a')
    expect(tabs[1]).toHaveAttribute('aria-controls', 't-panel-b')
  })

  it('renders the badge only when > 0', () => {
    setup('a')
    expect(screen.getByText('7')).toBeInTheDocument()
  })

  it('uses roving tabindex (only the active tab is in the tab sequence)', () => {
    setup('a')
    const tabs = screen.getAllByRole('tab')
    expect(tabs[0]).toHaveAttribute('tabindex', '0')
    expect(tabs[1]).toHaveAttribute('tabindex', '-1')
  })

  it('activates a tab on click', async () => {
    const user = userEvent.setup()
    const { onChange } = setup('a')

    await user.click(screen.getByRole('tab', { name: /Bravo/ }))
    expect(onChange).toHaveBeenCalledWith('b')
  })

  it('moves activation with ArrowRight / ArrowLeft (wraps at edges)', async () => {
    const user = userEvent.setup()
    const { onChange } = setup('a')

    screen.getByRole('tab', { name: /Alpha/ }).focus()
    await user.keyboard('{ArrowRight}')
    expect(onChange).toHaveBeenLastCalledWith('b')

    onChange.mockClear()
    await user.keyboard('{ArrowLeft}')
    expect(onChange).toHaveBeenLastCalledWith('a')

    onChange.mockClear()
    await user.keyboard('{ArrowLeft}')
    expect(onChange).toHaveBeenLastCalledWith('b')
  })

  it('jumps to the first/last tab with Home / End', async () => {
    const user = userEvent.setup()
    const { onChange } = setup('a')

    screen.getByRole('tab', { name: /Alpha/ }).focus()
    await user.keyboard('{End}')
    expect(onChange).toHaveBeenLastCalledWith('b')

    onChange.mockClear()
    await user.keyboard('{Home}')
    expect(onChange).toHaveBeenLastCalledWith('a')
  })
})
