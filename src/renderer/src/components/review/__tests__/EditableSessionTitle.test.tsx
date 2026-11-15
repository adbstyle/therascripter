import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EditableSessionTitle } from '../EditableSessionTitle'
import { createMockApi } from '../../../test/mockApi'

describe('EditableSessionTitle — Esc', () => {
  const windowKeydown = vi.fn()

  beforeEach(() => {
    window.api = createMockApi()
    window.addEventListener('keydown', windowKeydown)
  })
  afterEach(() => {
    window.removeEventListener('keydown', windowKeydown)
    windowKeydown.mockReset()
  })

  it('bricht nur die Bearbeitung ab und erreicht den Editor (window) nicht', async () => {
    const user = userEvent.setup()
    render(<EditableSessionTitle sessionId="s1" title="Erstgespräch" fallback="Ohne Titel" />)
    const heading = document.querySelector('h2') as HTMLElement
    expect(heading).toHaveTextContent('Erstgespräch')
    await user.click(heading)
    await user.keyboard(' neu')
    windowKeydown.mockReset()

    await user.keyboard('{Escape}')

    expect(windowKeydown).not.toHaveBeenCalled()
    expect(heading).toHaveTextContent('Erstgespräch')
    expect(heading).not.toHaveFocus()
    expect(window.api.summary.updateTitle).not.toHaveBeenCalled()
  })
})
