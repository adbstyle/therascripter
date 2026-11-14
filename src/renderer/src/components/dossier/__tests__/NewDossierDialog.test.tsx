import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NewDossierDialog } from '../NewDossierDialog'
import { createMockApi } from '../../../test/mockApi'
import { makeDossier } from '../../../test/dossierFixtures'

function setup(create: ReturnType<typeof vi.fn>) {
  window.api = createMockApi({ dossiers: { create } })
  const onCreated = vi.fn()
  const onClose = vi.fn()
  render(<NewDossierDialog onClose={onClose} onCreated={onCreated} />)
  return { onCreated, onClose, user: userEvent.setup() }
}

const vorname = () => screen.getByLabelText(/^Vorname/)
const nachname = () => screen.getByLabelText(/^Nachname/)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 10, 14, 10, 0))
})
afterEach(() => vi.useRealTimers())

describe('NewDossierDialog (#204 AK 1–8)', () => {
  it('startet im Vornamen und legt mit Vor- und Nachnamen an', async () => {
    const dossier = makeDossier()
    const create = vi.fn().mockResolvedValue({ ok: true, dossier })
    const { user, onCreated } = setup(create)
    expect(vorname()).toHaveFocus()
    await user.type(vorname(), 'Lukas')
    await user.type(nachname(), 'Hofer')
    await user.type(screen.getByLabelText('Dossier-ID'), 'PD-1188')
    await user.type(screen.getByLabelText('Geburtsdatum'), '3.2.1978{Enter}')
    expect(create).toHaveBeenCalledWith({
      firstName: 'Lukas',
      lastName: 'Hofer',
      externalId: 'PD-1188',
      birthDate: '1978-02-03',
      confirmDuplicate: false
    })
    expect(onCreated).toHaveBeenCalledWith(dossier)
  })

  it('verlangt Vor- und Nachnamen und meldet das am Feld (AK 2)', async () => {
    const create = vi.fn()
    const { user } = setup(create)
    await user.type(vorname(), '   ')
    await user.click(screen.getByRole('button', { name: 'Anlegen' }))
    expect(create).not.toHaveBeenCalled()
    expect(vorname()).toHaveAttribute('aria-invalid', 'true')
    expect(nachname()).toHaveAttribute('aria-invalid', 'true')
    expect(vorname()).toHaveAccessibleDescription('Der Vorname darf nicht leer sein.')
    expect(vorname()).toHaveFocus()
  })

  it('akzeptiert nur ein gültiges Geburtsdatum bis heute (AK 8)', async () => {
    const create = vi.fn()
    const { user } = setup(create)
    await user.type(vorname(), 'Anna')
    await user.type(nachname(), 'Meier')
    const birth = screen.getByLabelText('Geburtsdatum')
    for (const wrong of ['29.02.2025', '15.11.2026', '1978']) {
      await user.clear(birth)
      await user.type(birth, wrong)
      await user.click(screen.getByRole('button', { name: 'Anlegen' }))
      expect(birth).toHaveAttribute('aria-invalid', 'true')
    }
    expect(create).not.toHaveBeenCalled()
  })

  it('nennt den Besitzer einer vergebenen Dossier-ID (AK 5)', async () => {
    const create = vi
      .fn()
      .mockResolvedValue({ ok: false, reason: 'external-id-taken', ownerName: 'Meier, Anna' })
    const { user, onCreated } = setup(create)
    await user.type(vorname(), 'Lukas')
    await user.type(nachname(), 'Hofer')
    await user.type(screen.getByLabelText('Dossier-ID'), 'pd-0412')
    await user.click(screen.getByRole('button', { name: 'Anlegen' }))
    const idField = screen.getByLabelText('Dossier-ID')
    expect(idField).toHaveAccessibleDescription(
      'Die Dossier-ID «pd-0412» trägt bereits das Patientendossier «Meier, Anna».'
    )
    expect(idField).toHaveValue('pd-0412')
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('weist auf gleiche Namen hin und legt mit «Trotzdem anlegen» an (AK 6)', async () => {
    const dossier = makeDossier({ firstName: 'Anna', lastName: 'Meier' })
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        reason: 'duplicate-name',
        duplicates: [
          {
            id: 'd2',
            firstName: 'Anna',
            lastName: 'Meier',
            externalId: 'PD-0412',
            birthDate: '1969-06-11'
          }
        ]
      })
      .mockResolvedValueOnce({ ok: true, dossier })
    const { user, onCreated } = setup(create)
    await user.type(vorname(), 'anna')
    await user.type(nachname(), 'Meier')
    await user.click(screen.getByRole('button', { name: 'Anlegen' }))
    expect(
      await screen.findByText(
        'Es gibt bereits ein Patientendossier mit diesem Namen (PD-0412 · 11.06.1969). Sie können trotzdem ein weiteres anlegen.'
      )
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Trotzdem anlegen' }))
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ confirmDuplicate: true }))
    expect(onCreated).toHaveBeenCalledWith(dossier)
  })

  it('setzt den Hinweis zurück, wenn sich der Name ändert', async () => {
    const create = vi.fn().mockResolvedValue({
      ok: false,
      reason: 'duplicate-name',
      duplicates: [
        { id: 'd2', firstName: 'Anna', lastName: 'Meier', externalId: null, birthDate: null }
      ]
    })
    const { user } = setup(create)
    await user.type(vorname(), 'Anna')
    await user.type(nachname(), 'Meier')
    await user.click(screen.getByRole('button', { name: 'Anlegen' }))
    await screen.findByRole('button', { name: 'Trotzdem anlegen' })
    await user.type(nachname(), 'hans')
    expect(screen.getByRole('button', { name: 'Anlegen' })).toBeInTheDocument()
  })

  it('behält bei einem Fehler alle Eingaben und meldet ihn (AK 11)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const create = vi.fn().mockRejectedValue(new Error('kaputt'))
    const { user, onCreated } = setup(create)
    await user.type(vorname(), 'Lukas')
    await user.type(nachname(), 'Hofer')
    await user.click(screen.getByRole('button', { name: 'Anlegen' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Das Patientendossier konnte nicht angelegt werden.'
    )
    expect(vorname()).toHaveValue('Lukas')
    expect(nachname()).toHaveValue('Hofer')
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('hält den Fokus im Dialog (Fokusfalle)', async () => {
    const { user } = setup(vi.fn())
    screen.getByRole('button', { name: 'Anlegen' }).focus()
    await user.tab()
    expect(vorname()).toHaveFocus()
    await user.tab({ shift: true })
    expect(screen.getByRole('button', { name: 'Anlegen' })).toHaveFocus()
  })

  it('sperrt Esc, Abbrechen und Klick daneben, solange angelegt wird (Review #219)', async () => {
    let resolve!: (v: unknown) => void
    const create = vi.fn().mockReturnValue(new Promise((r) => (resolve = r)))
    const { user, onClose, onCreated } = setup(create)
    await user.type(vorname(), 'Lukas')
    await user.type(nachname(), 'Hofer')
    await user.click(screen.getByRole('button', { name: 'Anlegen' }))
    expect(screen.getByRole('button', { name: 'Abbrechen' })).toBeDisabled()
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()
    const dossier = makeDossier()
    resolve({ ok: true, dossier })
    await screen.findByRole('button', { name: 'Abbrechen' })
    await vi.waitFor(() => expect(onCreated).toHaveBeenCalledWith(dossier))
  })
})
