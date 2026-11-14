import { describe, it, expect, vi } from 'vitest'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DossierBadges } from '../DossierBadges'
import { MAX_RENDERED_DOSSIERS } from '../AssignDossiersPopover'
import { renderWithProviders } from '../../../test/renderWithProviders'
import { createMockApi } from '../../../test/mockApi'
import { makeDossierListItem, makeDossierRef } from '../../../test/dossierFixtures'
import type { DossierListItem, DossierRef } from '../../../../../shared/types/Dossier'

const HOFER = makeDossierListItem({ id: 'd1', firstName: 'Lukas', lastName: 'Hofer' })
const MEIER_A = makeDossierListItem({
  id: 'd2',
  firstName: 'Anna',
  lastName: 'Meier',
  externalId: 'PD-0412',
  birthDate: '1969-06-11'
})
const MEIER_B = makeDossierListItem({
  id: 'd3',
  firstName: 'Anna',
  lastName: 'Meier',
  externalId: 'PD-1201',
  birthDate: '1994-12-02'
})
const MEISSER = makeDossierListItem({
  id: 'd4',
  firstName: 'Jonas',
  lastName: 'Meisser',
  externalId: null,
  birthDate: null
})

function ref(item: DossierListItem): DossierRef {
  return makeDossierRef({
    id: item.id,
    firstName: item.firstName,
    lastName: item.lastName,
    externalId: item.externalId,
    birthDate: item.birthDate
  })
}

function setup(
  options: {
    assigned?: DossierRef[]
    list?: DossierListItem[]
    variant?: 'list' | 'editor' | 'timeline'
    assign?: ReturnType<typeof vi.fn>
    unassign?: ReturnType<typeof vi.fn>
    onOpenDossier?: (id: string) => void
  } = {}
) {
  const assign = options.assign ?? vi.fn().mockResolvedValue({ ok: true })
  const unassign = options.unassign ?? vi.fn().mockResolvedValue({ ok: true })
  window.api = createMockApi({
    dossiers: {
      list: vi.fn().mockResolvedValue(options.list ?? [HOFER, MEIER_A, MEIER_B, MEISSER]),
      assign,
      unassign
    }
  })
  const view = renderWithProviders(
    <DossierBadges
      sessionId="s1"
      sessionLabel="Supervision Fallbesprechung"
      dossiers={options.assigned ?? []}
      variant={options.variant ?? 'list'}
      currentDossierId="d1"
      onOpenDossier={options.onOpenDossier}
    />
  )
  return { ...view, assign, unassign, user: userEvent.setup() }
}

describe('DossierBadges (#205 AK 5)', () => {
  it('shows «Dossier zuordnen» without assignment and the names with one', () => {
    const { unmount } = setup()
    expect(screen.getByRole('button', { name: 'Dossier zuordnen' })).toBeInTheDocument()
    unmount()

    setup({ assigned: [ref(HOFER), ref(MEIER_A)] })
    expect(screen.getByText('Hofer, Lukas')).toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: 'Zugeordnet: Meier, Anna (PD-0412 · 11.06.1969) – Zuordnungen bearbeiten'
      })
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Dossier zuordnen' })).not.toBeInTheDocument()
  })

  it('shows only the other dossiers as «Auch in» in the timeline (AK 7)', () => {
    const { container, unmount } = setup({ variant: 'timeline', assigned: [ref(HOFER)] })
    expect(container).toBeEmptyDOMElement()
    unmount()

    setup({ variant: 'timeline', assigned: [ref(HOFER), ref(MEISSER)] })
    expect(screen.getByText('Auch in: Meisser, Jonas')).toBeInTheDocument()
    expect(screen.queryByText(/Hofer/)).not.toBeInTheDocument()
  })

  it('opens the dossier from the editor and offers «Zuordnen» there', async () => {
    const onOpenDossier = vi.fn()
    const { user } = setup({ variant: 'editor', assigned: [ref(HOFER)], onOpenDossier })
    await user.click(
      screen.getByRole('button', {
        name: 'Patientendossier Hofer, Lukas (PD-1188 · 03.02.1978) öffnen'
      })
    )
    expect(onOpenDossier).toHaveBeenCalledWith('d1')
    expect(screen.getByRole('button', { name: 'Zuordnen' })).toBeInTheDocument()
  })
})

describe('AssignDossiersPopover (#205 AK 1–3, 24)', () => {
  it('moves focus into the search and returns it on Esc', async () => {
    const { user } = setup()
    const trigger = screen.getByRole('button', { name: 'Dossier zuordnen' })
    await user.click(trigger)
    const dialog = await screen.findByRole('dialog', {
      name: 'Patientendossiers für «Supervision Fallbesprechung» zuordnen'
    })
    expect(within(dialog).getByRole('textbox', { name: 'Patientendossier suchen' })).toHaveFocus()
    expect(trigger).toHaveAttribute('aria-expanded', 'true')

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('labels each checkbox with name, ID and birth date for same names', async () => {
    const { user } = setup()
    await user.click(screen.getByRole('button', { name: 'Dossier zuordnen' }))
    expect(
      await screen.findByRole('checkbox', { name: /Meier, Anna\s*PD-0412 · 11\.06\.1969/ })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('checkbox', { name: /Meier, Anna\s*PD-1201 · 02\.12\.1994/ })
    ).toBeInTheDocument()
  })

  it('filters by parts of first and last name', async () => {
    const { user } = setup()
    await user.click(screen.getByRole('button', { name: 'Dossier zuordnen' }))
    await screen.findByRole('checkbox', { name: /Hofer/ })
    await user.type(screen.getByRole('textbox', { name: 'Patientendossier suchen' }), 'mei')
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: /Hofer/ })).toBeNull())
    expect(screen.getAllByRole('checkbox')).toHaveLength(3)

    await user.clear(screen.getByRole('textbox', { name: 'Patientendossier suchen' }))
    await user.type(screen.getByRole('textbox', { name: 'Patientendossier suchen' }), 'xyz')
    expect(await screen.findByText('Kein Patientendossier passt zu «xyz».')).toBeInTheDocument()
  })

  it('lists assigned dossiers first and checked', async () => {
    const { user } = setup({ assigned: [ref(MEISSER)] })
    await user.click(screen.getByRole('button', { name: /Zugeordnet: Meisser/ }))
    await screen.findByRole('checkbox', { name: /Hofer/ })
    const boxes = screen.getAllByRole('checkbox')
    expect(boxes[0]).toHaveAccessibleName(/Meisser, Jonas/)
    expect(boxes[0]).toBeChecked()
    expect(boxes[1]).not.toBeChecked()
  })

  it('assigns and unassigns immediately, one checkbox at a time', async () => {
    const { user, assign, unassign } = setup({ assigned: [ref(MEISSER)] })
    await user.click(screen.getByRole('button', { name: /Zugeordnet: Meisser/ }))
    await user.click(await screen.findByRole('checkbox', { name: /Hofer/ }))
    expect(assign).toHaveBeenCalledWith('s1', 'd1')
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /Hofer/ })).toBeChecked())

    await user.click(screen.getByRole('checkbox', { name: /Meisser/ }))
    expect(unassign).toHaveBeenCalledWith('s1', 'd4')
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /Meisser/ })).not.toBeChecked())
  })

  it('shows «Wird gespeichert» while the answer is pending', async () => {
    let resolve: (value: { ok: true }) => void = () => {}
    const assign = vi.fn(() => new Promise<{ ok: true }>((r) => (resolve = r)))
    const { user } = setup({ assign })
    await user.click(screen.getByRole('button', { name: 'Dossier zuordnen' }))
    const box = await screen.findByRole('checkbox', { name: /Hofer/ })
    await user.click(box)
    expect(box).toBeChecked()
    expect(box).toHaveAttribute('aria-disabled', 'true')
    expect(box).toHaveFocus()
    await user.click(box)
    expect(assign).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Wird gespeichert …')).toBeInTheDocument()
    await act(async () => resolve({ ok: true }))
    expect(screen.queryByText('Wird gespeichert …')).not.toBeInTheDocument()
    expect(box).toBeChecked()
  })

  it('reverts and names content and dossier when assigning fails (AK 24, PC 3)', async () => {
    const assign = vi.fn().mockResolvedValue({ ok: false, reason: 'not-found' })
    const { user } = setup({ assign })
    await user.click(screen.getByRole('button', { name: 'Dossier zuordnen' }))
    const box = await screen.findByRole('checkbox', { name: /Hofer/ })
    await user.click(box)
    await waitFor(() => expect(box).not.toBeChecked())
    expect(
      await screen.findByText(
        '«Supervision Fallbesprechung» konnte dem Patientendossier «Hofer, Lukas» nicht zugeordnet werden.'
      )
    ).toBeInTheDocument()
  })

  it('reverts when unassigning throws (AK 24, PC 3)', async () => {
    const unassign = vi.fn().mockRejectedValue(new Error('IPC kaputt'))
    const { user } = setup({ assigned: [ref(HOFER)], unassign })
    await user.click(screen.getByRole('button', { name: /Zugeordnet: Hofer/ }))
    const box = await screen.findByRole('checkbox', { name: /Hofer/ })
    expect(box).toBeChecked()
    await user.click(box)
    await waitFor(() => expect(box).toBeChecked())
    expect(
      await screen.findByText(
        'Die Zuordnung von «Supervision Fallbesprechung» zum Patientendossier «Hofer, Lukas» konnte nicht gelöst werden.'
      )
    ).toBeInTheDocument()
  })

  it('closes with «Fertig» and on a click outside', async () => {
    const { user } = setup()
    await user.click(screen.getByRole('button', { name: 'Dossier zuordnen' }))
    await user.click(await screen.findByRole('button', { name: 'Fertig' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Dossier zuordnen' }))
    await screen.findByRole('dialog')
    await user.click(document.body)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it(`renders at most ${MAX_RENDERED_DOSSIERS} rows and asks to narrow the search`, async () => {
    const many = Array.from({ length: 150 }, (_, i) =>
      makeDossierListItem({ id: `m${i}`, firstName: `Vorname${i}`, lastName: `Name${i}` })
    )
    const { user } = setup({ list: many })
    await user.click(screen.getByRole('button', { name: 'Dossier zuordnen' }))
    await screen.findByText('50 weitere — grenzen Sie die Suche ein.')
    expect(screen.getAllByRole('checkbox')).toHaveLength(MAX_RENDERED_DOSSIERS)
  })

  it('explains what to do when there is no dossier yet', async () => {
    const { user } = setup({ list: [] })
    await user.click(screen.getByRole('button', { name: 'Dossier zuordnen' }))
    expect(
      await screen.findByText(
        'Noch keine Patientendossiers. Legen Sie eines unter «Alle Patientendossiers» an.'
      )
    ).toBeInTheDocument()
  })
})
