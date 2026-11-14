import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import DossierPage from '../DossierPage'
import { renderWithProviders } from '../../test/renderWithProviders'
import { createMockApi, emitApiEvent } from '../../test/mockApi'
import { makeDossier, makeDossierListItem } from '../../test/dossierFixtures'
import { resetDossierDrafts } from '../../stores/dossierDrafts'
import type { UpdateDossierResult } from '../../../../shared/types/Dossier'

const okResult = (): UpdateDossierResult => ({ ok: true, dossier: makeDossier(), duplicates: [] })

function renderPage(update = vi.fn().mockResolvedValue(okResult())) {
  window.api = createMockApi({
    dossiers: {
      get: vi.fn().mockResolvedValue(makeDossier()),
      list: vi.fn().mockResolvedValue([makeDossierListItem({ entryCount: 0 })]),
      update
    }
  })
  const view = renderWithProviders(<DossierPage dossierId="d1" />, {
    route: { kind: 'dossier', dossierId: 'd1' }
  })
  return { ...view, update, user: userEvent.setup() }
}

const status = (): HTMLElement =>
  screen
    .getByRole('complementary', { name: 'Stammdaten' })
    .querySelector<HTMLElement>('[data-save-status]')!

beforeEach(() => {
  resetDossierDrafts()
})

describe('DossierPage (#204 AK 3/4/9–11)', () => {
  it('zeigt Kopf, leeren Verlauf und alle Stammdaten', async () => {
    renderPage()
    expect(await screen.findByRole('heading', { name: 'Lukas Hofer' })).toBeInTheDocument()
    expect(
      await screen.findByText('PD-1188 · geboren 03.02.1978 · Keine Einträge')
    ).toBeInTheDocument()
    expect(
      await within(screen.getByRole('region', { name: 'Verlauf' })).findByText(
        'Noch keine Sitzungen oder PDF-Dokumente'
      )
    ).toBeInTheDocument()
    expect(screen.getByLabelText(/^Vorname/)).toHaveValue('Lukas')
    expect(screen.getByLabelText(/^Nachname/)).toHaveValue('Hofer')
    expect(screen.getByLabelText('Dossier-ID')).toHaveValue('PD-1188')
    expect(screen.getByLabelText('Geburtsdatum')).toHaveValue('03.02.1978')
    // Mehrzeilige Freitexte (AK 4)
    expect(screen.getByLabelText('Diagnosen').tagName).toBe('TEXTAREA')
    expect(screen.getByLabelText('Medikation').tagName).toBe('TEXTAREA')
    expect(screen.getByLabelText('Notiz').tagName).toBe('TEXTAREA')
    // Unverändert: noch kein «Gespeichert» (Sichtprüfung)
    expect(status()).not.toBeVisible()
  })

  it('legt Verlauf und Stammdaten in ein Raster, das ab 51rem Inhaltsbreite zweispaltig ist', async () => {
    renderPage()
    const timeline = await screen.findByRole('region', { name: 'Verlauf' })
    const masterData = await screen.findByRole('complementary', { name: 'Stammdaten' })
    const grid = timeline.parentElement!
    expect(masterData.parentElement).toBe(grid)
    expect(grid.className).toContain(
      '@min-[51rem]:grid-cols-[minmax(480px,1fr)_minmax(300px,380px)]'
    )
    expect(grid.parentElement!.className).toContain('@container')
    // Kopf-Aktion behält ihren Namen, auch wenn schmal nur das Symbol steht
    expect(screen.getByRole('button', { name: 'Im Dossier suchen' })).toBeInTheDocument()
  })

  it('speichert Änderungen laufend ohne Speichern-Knopf (AK 10)', async () => {
    const { user, update } = renderPage()
    const note = await screen.findByLabelText('Notiz')
    await user.type(note, '{Enter}Kostengutsprache bis März.')
    expect(status()).toHaveTextContent('Wird gespeichert …')
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('d1', {
        note: 'Termine dienstags.\nKostengutsprache bis März.'
      })
    )
    await waitFor(() => expect(status()).toHaveTextContent('Gespeichert'))
    expect(status()).toBeVisible()
    expect(screen.queryByRole('button', { name: /Speichern/ })).not.toBeInTheDocument()
  })

  it('speichert beim Verlassen eines Felds sofort', async () => {
    const { user, update } = renderPage()
    const diagnoses = await screen.findByLabelText('Diagnosen')
    await user.type(diagnoses, 'X')
    await user.tab()
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
  })

  it('meldet einen leeren Namen am Feld, behält ihn und überlebt das Verlassen der Seite (AK 2/11)', async () => {
    const { user, update, unmount } = renderPage()
    const last = await screen.findByLabelText(/^Nachname/)
    await user.clear(last)
    await waitFor(() =>
      expect(last).toHaveAccessibleDescription(
        'Der Nachname darf nicht leer sein. Diese Änderung ist noch nicht gespeichert.'
      )
    )
    expect(last).toHaveAttribute('aria-invalid', 'true')
    expect(status()).toHaveTextContent('Nicht gespeichert')
    expect(update).not.toHaveBeenCalled()
    unmount()

    renderPage(update)
    const again = await screen.findByLabelText(/^Nachname/)
    expect(again).toHaveValue('')
    expect(again).toHaveAttribute('aria-invalid', 'true')
    // Der Kopf zeigt weiter den gespeicherten Namen
    expect(screen.getByRole('heading', { name: 'Lukas Hofer' })).toBeInTheDocument()
  })

  it('zeigt eine vergebene Dossier-ID am Feld, ohne die Eingabe zu verlieren (AK 5/11)', async () => {
    const update = vi
      .fn()
      .mockResolvedValue({ ok: false, reason: 'external-id-taken', ownerName: 'Meier, Anna' })
    const { user } = renderPage(update)
    const id = await screen.findByLabelText('Dossier-ID')
    await user.clear(id)
    await user.type(id, 'PD-0412')
    await user.tab()
    await waitFor(() =>
      expect(id).toHaveAccessibleDescription(
        'Die Dossier-ID «PD-0412» trägt bereits das Patientendossier «Meier, Anna». Diese Änderung ist noch nicht gespeichert.'
      )
    )
    expect(id).toHaveValue('PD-0412')
  })

  it('meldet einen technischen Fehler deutlich und speichert über «Erneut versuchen» (AK 11)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const update = vi.fn().mockRejectedValueOnce(new Error('weg')).mockResolvedValue(okResult())
    const { user } = renderPage(update)
    const medication = await screen.findByLabelText('Medikation')
    await user.type(medication, ', abends')
    await user.tab()
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Eine Änderung konnte nicht gespeichert werden. Ihre Eingaben bleiben erhalten.'
    )
    expect(medication).toHaveValue('Sertralin 50 mg, morgens, abends')
    await user.click(screen.getByRole('button', { name: 'Erneut versuchen' }))
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })

  it('weist nach einer Namensänderung auf gleiche Namen hin (AK 6)', async () => {
    const update = vi.fn().mockResolvedValue({
      ok: true,
      dossier: makeDossier({ firstName: 'Anna', lastName: 'Meier' }),
      duplicates: [
        { id: 'd2', firstName: 'Anna', lastName: 'Meier', externalId: 'PD-0412', birthDate: null }
      ]
    })
    const { user } = renderPage(update)
    const first = await screen.findByLabelText(/^Vorname/)
    await user.clear(first)
    await user.type(first, 'Anna')
    await user.tab()
    expect(
      await screen.findByText(
        'Es gibt bereits ein Patientendossier mit diesem Namen (PD-0412). Die Änderung ist trotzdem gespeichert.'
      )
    ).toBeInTheDocument()
  })

  it('überschreibt das Formular nicht, wenn der Kopf nach dossiers:changed nachlädt', async () => {
    const { user } = renderPage()
    const note = await screen.findByLabelText('Notiz')
    await user.clear(note)
    await user.type(note, 'neu')
    vi.mocked(window.api.dossiers.get).mockResolvedValue(makeDossier({ lastName: 'Hofer-Meier' }))
    act(() => emitApiEvent(window.api, 'dossiers.onChanged', { deletedIds: [] }))
    expect(await screen.findByRole('heading', { name: 'Lukas Hofer-Meier' })).toBeInTheDocument()
    expect(note).toHaveValue('neu')
  })

  it('meldet ein Dossier, das es nicht mehr gibt', async () => {
    window.api = createMockApi({ dossiers: { get: vi.fn().mockResolvedValue(null) } })
    renderWithProviders(<DossierPage dossierId="weg" />, {
      route: { kind: 'dossier', dossierId: 'weg' }
    })
    expect(
      await screen.findByText('Dieses Patientendossier gibt es nicht mehr.')
    ).toBeInTheDocument()
  })

  it('sagt nur den Wechsel auf «Nicht gespeichert» und zurück an, nicht jedes Speichern (Review #219)', async () => {
    const { user } = renderPage()
    const live = (): HTMLElement =>
      within(screen.getByRole('complementary', { name: 'Stammdaten' })).getAllByRole('status')[0]
    const note = await screen.findByLabelText('Notiz')
    expect(live()).toHaveTextContent('')
    await user.type(note, 'x')
    expect(status()).toHaveTextContent('Wird gespeichert …')
    expect(live()).toHaveTextContent('')
    await waitFor(() => expect(status()).toHaveTextContent('Gespeichert'))
    expect(live()).toHaveTextContent('')

    const first = screen.getByLabelText(/^Vorname/)
    await user.clear(first)
    await waitFor(() => expect(live()).toHaveTextContent('Nicht gespeichert'))
    await user.type(first, 'Lukas')
    await waitFor(() => expect(live()).toHaveTextContent('Gespeichert'))
  })
})
