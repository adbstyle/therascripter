import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { ConfirmDialog } from '../ConfirmDialog'
import { DialogShell } from '../DialogShell'

describe('ConfirmDialog', () => {
  const base = {
    title: 'Löschen?',
    message: 'Wirklich löschen?',
    confirmLabel: 'Löschen',
    onConfirm: vi.fn(),
    onCancel: vi.fn()
  }

  it('zeigt details als Abschnitt «Gelöscht werden:»', () => {
    render(<ConfirmDialog {...base} details={['Transkript']} />)
    expect(screen.getByText('Gelöscht werden:')).toBeInTheDocument()
    expect(screen.getByRole('listitem')).toHaveTextContent('Transkript')
  })

  it('zeigt mehrere Abschnitte und lässt leere weg (Epic #192)', () => {
    render(
      <ConfirmDialog
        {...base}
        sections={[
          { heading: 'Gelöscht werden:', items: ['2 Sitzungen'] },
          { heading: 'Erhalten bleiben:', items: ['Einträge in der Sperrliste'] },
          { heading: 'Leer:', items: [] }
        ]}
      />
    )
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Gelöscht werden:')).toBeInTheDocument()
    expect(within(dialog).getByText('Erhalten bleiben:')).toBeInTheDocument()
    expect(within(dialog).queryByText('Leer:')).not.toBeInTheDocument()
    expect(
      within(dialog)
        .getAllByRole('listitem')
        .map((li) => li.textContent)
    ).toEqual(['2 Sitzungen', 'Einträge in der Sperrliste'])
  })
})

describe('DialogShell', () => {
  it('ist standardmässig mittelbreit und auf Wunsch breit', () => {
    const { rerender } = render(
      <DialogShell ariaLabel="Test" onDismiss={() => {}}>
        <p>Inhalt</p>
      </DialogShell>
    )
    expect(screen.getByText('Inhalt').parentElement).toHaveClass('max-w-md')
    rerender(
      <DialogShell ariaLabel="Test" onDismiss={() => {}} size="lg">
        <p>Inhalt</p>
      </DialogShell>
    )
    expect(screen.getByText('Inhalt').parentElement).toHaveClass('max-w-lg')
  })
})
