import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DeleteDossierDialog } from '../DeleteDossierDialog'
import { DossierHeaderActions } from '../DossierHeaderActions'
import { renderWithProviders } from '../../../test/renderWithProviders'
import { createMockApi, emitApiEvent } from '../../../test/mockApi'
import { makeDeletePreview } from '../../../test/dossierFixtures'
import { useNavigation } from '../../../navigation/navigation'
import {
  acquireDossierEditor,
  hasDossierDraft,
  resetDossierDrafts
} from '../../../stores/dossierDrafts'
import { makeDossier } from '../../../test/dossierFixtures'

// Aufnahme steuerbar ohne Mikrofon: «Aufnahme stoppen» im gesperrten Dialog
const rec = vi.hoisted(() => ({ recording: false, stop: vi.fn() }))
vi.mock('../../../hooks/useRecording', async () => {
  const { createValueStore } = await import('../../../utils/valueStore')
  const level = createValueStore(0)
  const duration = createValueStore(0)
  return {
    useRecording: () => ({
      isRecording: rec.recording,
      sessionId: rec.recording ? 'rec-1' : null,
      level,
      duration,
      error: null,
      startRecording: vi.fn(),
      stopRecording: rec.stop
    })
  }
})

function setup(
  dossiers: Partial<typeof window.api.dossiers>,
  props: { onClose?: () => void; onDeleted?: () => void } = {}
) {
  window.api = createMockApi({ dossiers })
  const onClose = props.onClose ?? vi.fn()
  const onDeleted = props.onDeleted ?? vi.fn()
  renderWithProviders(
    <DeleteDossierDialog dossierId="d1" onClose={onClose} onDeleted={onDeleted} />
  )
  return { onClose, onDeleted, user: userEvent.setup() }
}

beforeEach(() => {
  rec.recording = false
  rec.stop.mockReset()
})

describe('DeleteDossierDialog (#204 AK 16/17, #207 AK 1/2)', () => {
  it('unterscheidet gleichnamige Dossiers schon im Titel (ID · Geburtsdatum)', async () => {
    const self = makeDossier({ id: 'd1' })
    setup({
      deletePreview: vi.fn().mockResolvedValue(makeDeletePreview()),
      get: vi.fn().mockResolvedValue(self),
      list: vi.fn().mockResolvedValue([
        { ...self, entryCount: 2, lastEntryDay: null },
        {
          ...self,
          id: 'd2',
          externalId: 'PD-2001',
          birthDate: null,
          entryCount: 0,
          lastEntryDay: null
        }
      ])
    })
    expect(
      await screen.findByRole('dialog', {
        name: 'Patientendossier Lukas Hofer (PD-1188 · 03.02.1978) löschen?'
      })
    ).toBeInTheDocument()
  })

  it('nennt, welche Angaben gelöscht werden, und startet auf «Abbrechen» (AK 17)', async () => {
    setup({ deletePreview: vi.fn().mockResolvedValue(makeDeletePreview()) })
    const dialog = await screen.findByRole('dialog', {
      name: 'Patientendossier Lukas Hofer löschen?'
    })
    expect(within(dialog).getByText('Gelöscht werden:')).toBeInTheDocument()
    expect(
      within(dialog).getByText('Stammdaten, Diagnosen, Medikation und Notiz')
    ).toBeInTheDocument()
    expect(within(dialog).queryByText('Erhalten bleiben:')).not.toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Abbrechen' })).toHaveFocus()
    expect(within(dialog).getByRole('button', { name: 'Dossier löschen' })).toBeInTheDocument()
  })

  it('zählt mitgelöschte und erhaltene Inhalte nach aktuellem Stand (#207 AK 1)', async () => {
    setup({
      deletePreview: vi.fn().mockResolvedValue(
        makeDeletePreview({
          exclusive: { sessions: 6, pdfs: 2 },
          shared: {
            sessions: 1,
            pdfs: 0,
            otherDossiers: [
              { id: 'd2', firstName: 'Maria', lastName: 'Hofer', externalId: null, birthDate: null }
            ]
          }
        })
      )
    })
    const dialog = await screen.findByRole('dialog')
    expect(
      within(dialog).getByText('6 Sitzungen und 2 PDF-Dokumente samt Text und Zusammenfassung')
    ).toBeInTheDocument()
    expect(
      within(dialog).getByText('1 Sitzung, die auch im Dossier Hofer, Maria liegt')
    ).toBeInTheDocument()
    expect(within(dialog).getByText('Einträge in der Sperrliste')).toBeInTheDocument()
    expect(
      within(dialog).getByRole('button', { name: 'Dossier und 8 Inhalte löschen' })
    ).toBeInTheDocument()
  })

  it('lädt die Vorschau bei sessions:changed neu, solange der Dialog offen ist', async () => {
    const deletePreview = vi.fn().mockResolvedValue(makeDeletePreview())
    setup({ deletePreview })
    await screen.findByRole('button', { name: 'Dossier löschen' })
    deletePreview.mockResolvedValue(makeDeletePreview({ exclusive: { sessions: 1, pdfs: 0 } }))
    act(() => emitApiEvent(window.api, 'sessions.onChanged', { deletedIds: [] }))
    expect(
      await screen.findByRole('button', { name: 'Dossier und 1 Inhalt löschen' })
    ).toBeInTheDocument()
  })

  it('löscht mit dem gesehenen Stand und meldet den Erfolg', async () => {
    const del = vi.fn().mockResolvedValue({ ok: true, deletedSessionIds: [], incomplete: false })
    const { user, onDeleted } = setup({
      deletePreview: vi.fn().mockResolvedValue(makeDeletePreview({ fingerprint: 'fp-42' })),
      delete: del
    })
    await user.click(await screen.findByRole('button', { name: 'Dossier löschen' }))
    expect(del).toHaveBeenCalledWith('d1', 'fp-42')
    expect(onDeleted).toHaveBeenCalled()
  })

  it('ersetzt bei «changed» die Zahlen, ohne zu löschen', async () => {
    const changed = makeDeletePreview({ exclusive: { sessions: 2, pdfs: 0 }, fingerprint: 'fp-2' })
    const del = vi.fn().mockResolvedValue({ ok: false, reason: 'changed', preview: changed })
    const { user, onDeleted } = setup({
      deletePreview: vi.fn().mockResolvedValue(makeDeletePreview()),
      delete: del
    })
    await user.click(await screen.findByRole('button', { name: 'Dossier löschen' }))
    expect(await screen.findByText(/Inzwischen hat sich geändert/)).toBeInTheDocument()
    expect(screen.getByText('2 Sitzungen samt Text und Zusammenfassung')).toBeInTheDocument()
    expect(onDeleted).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Dossier und 2 Inhalte löschen' }))
    expect(del).toHaveBeenLastCalledWith('d1', 'fp-2')
  })

  it('nennt bei laufender, nur diesem Dossier zugeordneter Aufnahme den Grund (#207 AK 2)', async () => {
    rec.recording = true
    const { user } = setup({
      deletePreview: vi.fn().mockResolvedValue(makeDeletePreview({ blockedByRecording: true }))
    })
    const dialog = await screen.findByRole('dialog', {
      name: 'Patientendossier kann gerade nicht gelöscht werden'
    })
    expect(within(dialog).getByText(/Für Lukas Hofer läuft eine Aufnahme/)).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: /löschen/ })).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Aufnahme stoppen' }))
    expect(rec.stop).toHaveBeenCalled()
  })

  it('«Aufnahme stoppen» stoppt wirklich, danach zeigt der Dialog den aktuellen Stand (#207 AK 2)', async () => {
    rec.recording = true
    const deletePreview = vi
      .fn()
      .mockResolvedValue(
        makeDeletePreview({ blockedByRecording: true, exclusive: { sessions: 1, pdfs: 0 } })
      )
    // Wie im Main-Prozess: der Stopp setzt die Sitzung auf «wartet» und meldet
    // sessions:changed — ab dann sperrt die Aufnahme nicht mehr
    rec.stop.mockImplementation(async () => {
      deletePreview.mockResolvedValue(
        makeDeletePreview({ blockedByRecording: false, exclusive: { sessions: 1, pdfs: 0 } })
      )
      emitApiEvent(window.api, 'sessions.onChanged', { deletedIds: [] })
    })
    const { user } = setup({ deletePreview })
    const dialog = await screen.findByRole('dialog', {
      name: 'Patientendossier kann gerade nicht gelöscht werden'
    })
    await user.click(within(dialog).getByRole('button', { name: 'Aufnahme stoppen' }))
    expect(rec.stop).toHaveBeenCalledTimes(1)
    expect(
      await screen.findByRole('button', { name: 'Dossier und 1 Inhalt löschen' })
    ).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Patientendossier Lukas Hofer löschen?')
    // Fokus wieder auf dem sicheren Knopf
    expect(screen.getByRole('button', { name: 'Abbrechen' })).toHaveFocus()
  })

  it('nennt die Suchdaten nur, soweit es sie gibt (Epic EK 22)', async () => {
    setup({
      deletePreview: vi.fn().mockResolvedValue(
        makeDeletePreview({
          exclusive: { sessions: 2, pdfs: 0 },
          search: { exclusiveSearchable: 1, recentQueries: 2 }
        })
      )
    })
    const dialog = await screen.findByRole('dialog')
    const items = within(dialog)
      .getAllByRole('listitem')
      .map((li) => li.textContent)
    expect(items).toEqual([
      '2 Sitzungen samt Text und Zusammenfassung',
      'Für die Suche aufbereitete Texte',
      'Stammdaten, Diagnosen, Medikation und Notiz',
      '2 letzte Suchanfragen mit Namen oder ID dieses Patientendossiers',
      'Einträge in der Sperrliste'
    ])
  })

  it('erwähnt keine Suchdaten, wenn nichts davon besteht', async () => {
    setup({
      deletePreview: vi
        .fn()
        .mockResolvedValue(makeDeletePreview({ exclusive: { sessions: 1, pdfs: 0 } }))
    })
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).queryByText(/Suche/)).not.toBeInTheDocument()
  })

  it('wechselt bei der Antwort «blocked-recording» in die gesperrte Ansicht', async () => {
    const { user } = setup({
      // Die nachgeladene Vorschau bestätigt die Sperre (die Aufnahme lief schon)
      deletePreview: vi
        .fn()
        .mockResolvedValueOnce(makeDeletePreview())
        .mockResolvedValue(makeDeletePreview({ blockedByRecording: true })),
      delete: vi.fn().mockResolvedValue({ ok: false, reason: 'blocked-recording' })
    })
    await user.click(await screen.findByRole('button', { name: 'Dossier löschen' }))
    expect(
      await screen.findByRole('heading', {
        name: 'Patientendossier kann gerade nicht gelöscht werden'
      })
    ).toBeInTheDocument()
  })

  it('bleibt bei einem Fehler mit Meldung offen (AK 11)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { user, onDeleted, onClose } = setup({
      deletePreview: vi.fn().mockResolvedValue(makeDeletePreview()),
      delete: vi.fn().mockRejectedValue(new Error('kaputt'))
    })
    await user.click(await screen.findByRole('button', { name: 'Dossier löschen' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Das Patientendossier konnte nicht gelöscht werden.'
    )
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(onDeleted).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })
})

function RouteProbe(): React.JSX.Element {
  const { route } = useNavigation()
  return <p>Route: {route.kind}</p>
}

describe('DossierHeaderActions', () => {
  it('löscht über «Weitere Aktionen», führt zur Übersicht und meldet es (AK 16, PC 3)', async () => {
    const user = userEvent.setup()
    window.api = createMockApi({
      dossiers: {
        deletePreview: vi.fn().mockResolvedValue(makeDeletePreview()),
        delete: vi.fn().mockResolvedValue({ ok: true, deletedSessionIds: [], incomplete: false })
      }
    })
    resetDossierDrafts()
    // Ein Entwurf mit Klarnamen darf das Löschen nicht überleben
    acquireDossierEditor(makeDossier(), vi.fn()).change('firstName', '')
    expect(hasDossierDraft('d1')).toBe(true)
    renderWithProviders(
      <>
        <DossierHeaderActions dossierId="d1" />
        <RouteProbe />
      </>,
      { route: { kind: 'dossier', dossierId: 'd1' } }
    )
    const trigger = screen.getByRole('button', { name: 'Weitere Aktionen' })
    await user.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    const item = screen.getByRole('menuitem', { name: 'Patientendossier löschen' })
    expect(item).toHaveFocus()
    await user.click(item)
    await user.click(await screen.findByRole('button', { name: 'Dossier löschen' }))
    expect(await screen.findByText('Route: dossiers')).toBeInTheDocument()
    expect(await screen.findByText('Patientendossier gelöscht')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(hasDossierDraft('d1')).toBe(false)
  })

  it('schliesst das Menü mit Escape und gibt den Fokus zurück', async () => {
    const user = userEvent.setup()
    window.api = createMockApi()
    renderWithProviders(<DossierHeaderActions dossierId="d1" />)
    await user.click(screen.getByRole('button', { name: 'Weitere Aktionen' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Weitere Aktionen' })).toHaveFocus()
  })
})
