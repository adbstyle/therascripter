import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor, render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DocumentDateButton } from '../DocumentDateButton'
import { createMockApi } from '../../../test/mockApi'

/** #205 AK 18–21, 24 — Dokumentdatum festlegen und ändern. */

function setup(
  documentDate: string | null,
  setDocumentDate = vi.fn().mockResolvedValue({ ok: true }),
  onSaved = vi.fn()
) {
  window.api = createMockApi({ sessions: { setDocumentDate } })
  render(
    <DocumentDateButton
      session={{ id: 'p1', createdAt: '2026-11-08T09:00:00.000Z', documentDate }}
      sessionLabel="Überweisung Hausarzt"
      onSaved={onSaved}
    />
  )
  return {
    setDocumentDate,
    onSaved,
    user: userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 10, 14, 12, 0))
})
afterEach(() => {
  vi.useRealTimers()
})

describe('DocumentDateButton', () => {
  it('labels the import date as such while none is set (AK 19/20)', () => {
    setup(null)
    expect(
      screen.getByRole('button', {
        name: 'Dokumentdatum festlegen, es gilt das Importdatum 08.11.2026'
      })
    ).toHaveTextContent('08.11.2026 · Importdatum')
  })

  it('shows a set date without marker (AK 20)', () => {
    setup('2026-11-02')
    expect(
      screen.getByRole('button', { name: 'Dokumentdatum 02.11.2026 ändern' })
    ).toHaveTextContent(/^02\.11\.2026$/)
  })
})

describe('DocumentDateDialog', () => {
  it('sets a date and reports it (AK 18)', async () => {
    const { user, setDocumentDate, onSaved } = setup(null)
    await user.click(screen.getByRole('button', { name: /Dokumentdatum festlegen/ }))
    const dialog = screen.getByRole('dialog', { name: 'Dokumentdatum festlegen' })
    expect(dialog).toHaveTextContent('Importiert am 08.11.2026')
    const input = screen.getByLabelText('Dokumentdatum')
    expect(input).toHaveFocus()
    await user.type(input, '02.11.2026')
    await user.click(screen.getByRole('button', { name: 'Übernehmen' }))
    expect(setDocumentDate).toHaveBeenCalledWith('p1', '2026-11-02')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(onSaved).toHaveBeenCalledWith('2026-11-02')
  })

  it('changes a set date, prefilled with the current one (AK 18)', async () => {
    const { user, setDocumentDate } = setup('2026-11-02')
    await user.click(screen.getByRole('button', { name: /ändern/ }))
    const input = screen.getByLabelText('Dokumentdatum')
    expect(input).toHaveValue('02.11.2026')
    await user.clear(input)
    await user.type(input, '01.10.2026{Enter}')
    expect(setDocumentDate).toHaveBeenCalledWith('p1', '2026-10-01')
  })

  it('offers no way back to the import date (OOS 3)', async () => {
    const { user } = setup('2026-11-02')
    await user.click(screen.getByRole('button', { name: /ändern/ }))
    expect(screen.queryByRole('button', { name: /Importdatum verwenden/ })).not.toBeInTheDocument()
  })

  it.each([
    ['', 'Bitte geben Sie ein Datum ein.'],
    ['11.2026', 'Bitte ein vollständiges, gültiges Datum im Format TT.MM.JJJJ angeben.'],
    ['31.04.2026', 'Bitte ein vollständiges, gültiges Datum im Format TT.MM.JJJJ angeben.'],
    ['15.11.2026', 'Das Dokumentdatum darf nicht nach dem heutigen Tag liegen.']
  ])('rejects «%s» with a message tied to the field (AK 21)', async (input, message) => {
    const { user, setDocumentDate } = setup(null)
    await user.click(screen.getByRole('button', { name: /Dokumentdatum festlegen/ }))
    const field = screen.getByLabelText('Dokumentdatum')
    if (input) await user.type(field, input)
    await user.click(screen.getByRole('button', { name: 'Übernehmen' }))
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(field).toHaveAccessibleDescription(expect.stringContaining(message))
    expect(setDocumentDate).not.toHaveBeenCalled()
  })

  it('accepts today', async () => {
    const { user, setDocumentDate } = setup(null)
    await user.click(screen.getByRole('button', { name: /Dokumentdatum festlegen/ }))
    await user.type(screen.getByLabelText('Dokumentdatum'), '14.11.2026{Enter}')
    expect(setDocumentDate).toHaveBeenCalledWith('p1', '2026-11-14')
  })

  it('stays open with a message when saving fails (AK 24, PC 3)', async () => {
    const setDocumentDate = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: 'not-found' })
      .mockRejectedValueOnce(new Error('IPC'))
    const { user, onSaved } = setup(null, setDocumentDate)
    await user.click(screen.getByRole('button', { name: /Dokumentdatum festlegen/ }))
    await user.type(screen.getByLabelText('Dokumentdatum'), '02.11.2026{Enter}')
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Das Dokumentdatum konnte nicht gespeichert werden. Das bisherige Datum gilt weiter.'
    )
    await user.click(screen.getByRole('button', { name: 'Übernehmen' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('closes with Abbrechen without saving', async () => {
    const { user, setDocumentDate } = setup(null)
    await user.click(screen.getByRole('button', { name: /Dokumentdatum festlegen/ }))
    await user.click(screen.getByRole('button', { name: 'Abbrechen' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(setDocumentDate).not.toHaveBeenCalled()
  })
})
