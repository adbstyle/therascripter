import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { BlocklistConfirmDialog } from '../BlocklistConfirmDialog'

describe('BlocklistConfirmDialog — term not selectable (#203 AK 9)', () => {
  it('the clear-name term is select-none', () => {
    render(
      <BlocklistConfirmDialog
        term="Ruth Gerber"
        type="PERSON"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    expect(screen.getByText(/Ruth Gerber/)).toHaveClass('select-none')
  })
})
