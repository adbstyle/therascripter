import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ReviewEditor from '../ReviewEditor'
import { ToastProvider } from '../../contexts/ToastContext'
import { _resetViewModeStoreForTests } from '../../viewMode/viewModeStore'
import { createMockApi, emitApiEvent, makeSession } from '../../test/mockApi'
import { makeDossierListItem, makeDossierRef } from '../../test/dossierFixtures'
import type { ReviewData } from '../../../../shared/types'

/** #205 — Patientendossiers und Dokumentdatum im Kopf einer geöffneten Sitzung. */

function reviewData(overrides: Partial<ReviewData> = {}): ReviewData {
  return {
    document: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Text des Berichts.' }] }]
    },
    entityMap: {},
    sessionType: 'pdf',
    sessionTitle: 'Austrittsbericht Klinik',
    titleSnapshot: null,
    processedWithModels: null,
    reviewAt: null,
    audioStats: null,
    createdAt: '2026-11-08T09:00:00.000Z',
    documentDate: null,
    ...overrides
  }
}

const HOFER = makeDossierRef()
const MARIA = makeDossierRef({ id: 'd2', firstName: 'Maria', externalId: null, birthDate: null })

async function openEditor(
  options: { data?: Partial<ReviewData>; dossiers?: ReturnType<typeof vi.fn> } = {}
) {
  const listForSession = options.dossiers ?? vi.fn().mockResolvedValue([HOFER])
  window.api = createMockApi({
    review: {
      load: vi.fn().mockResolvedValue(reviewData(options.data)),
      save: vi.fn().mockResolvedValue(undefined),
      exportClipboard: vi.fn()
    },
    dossiers: {
      listForSession,
      list: vi
        .fn()
        .mockResolvedValue([
          makeDossierListItem(),
          makeDossierListItem({ id: 'd2', firstName: 'Maria', externalId: null, birthDate: null })
        ])
    },
    sessions: {
      list: vi.fn().mockResolvedValue([
        {
          ...makeSession({ id: 's1', title: 'Austrittsbericht Klinik', type: 'pdf' }),
          dossiers: [HOFER, MARIA]
        }
      ]),
      setDocumentDate: vi.fn().mockResolvedValue({ ok: true })
    }
  })
  _resetViewModeStoreForTests()
  const onBack = vi.fn()
  const onOpenDossier = vi.fn()
  render(
    <ToastProvider>
      <ReviewEditor sessionId="s1" onBack={onBack} onOpenDossier={onOpenDossier} />
    </ToastProvider>
  )
  await screen.findByText('Text des Berichts.')
  return { onBack, onOpenDossier, listForSession, user: userEvent.setup() }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 10, 14, 12, 0))
})
afterEach(() => {
  vi.useRealTimers()
  _resetViewModeStoreForTests()
})

describe('ReviewEditor — Patientendossiers im Kopf (#205 AK 5)', () => {
  it('shows the dossiers and opens one on click', async () => {
    const { onOpenDossier, user } = await openEditor()
    const badge = await screen.findByRole('button', {
      name: 'Patientendossier Hofer, Lukas (PD-1188 · 03.02.1978) öffnen'
    })
    await user.click(badge)
    expect(onOpenDossier).toHaveBeenCalledWith('d1')
  })

  it('reloads the dossiers when assignments change', async () => {
    const listForSession = vi.fn().mockResolvedValueOnce([HOFER]).mockResolvedValue([HOFER, MARIA])
    await openEditor({ dossiers: listForSession })
    await screen.findByText('Hofer, Lukas')
    await act(async () => emitApiEvent(window.api, 'sessions.onChanged', { deletedIds: [] }))
    expect(await screen.findByText('Hofer, Maria')).toBeInTheDocument()
  })

  it('assigns from the editor; Esc closes the selection, not the editor (AK 1)', async () => {
    const { onBack, user } = await openEditor()
    await user.click(await screen.findByRole('button', { name: 'Zuordnen' }))
    await user.click(await screen.findByRole('checkbox', { name: /Hofer, Maria/ }))
    expect(window.api.dossiers.assign).toHaveBeenCalledWith('s1', 'd2')

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(onBack).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('names the dossiers in the delete dialog, as of opening it (AK 23)', async () => {
    const { user } = await openEditor()
    await user.click(screen.getByRole('button', { name: 'Transkription löschen' }))
    const dialog = await screen.findByRole('dialog', { name: 'Transkription löschen' })
    expect(within(dialog).getByText('Hofer, Lukas (PD-1188 · 03.02.1978)')).toBeInTheDocument()
    expect(within(dialog).getByText('Hofer, Maria')).toBeInTheDocument()
  })
})

describe('ReviewEditor — Dokumentdatum (#205 AK 18/20)', () => {
  it('shows the import date of a PDF as such and sets a document date', async () => {
    const { onBack, user } = await openEditor()
    const button = screen.getByRole('button', {
      name: 'Dokumentdatum festlegen, es gilt das Importdatum 08.11.2026'
    })
    expect(button).toHaveTextContent('08.11.2026 · Importdatum')
    await user.click(button)
    await user.type(screen.getByLabelText('Dokumentdatum'), '02.11.2026')
    await user.keyboard('{Escape}')
    // Esc schliesst nur den Dialog
    expect(onBack).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: /Dokumentdatum festlegen/ }))
    await user.type(screen.getByLabelText('Dokumentdatum'), '02.11.2026{Enter}')
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Dokumentdatum 02.11.2026 ändern' })
      ).toBeInTheDocument()
    )
    expect(window.api.sessions.setDocumentDate).toHaveBeenCalledWith('s1', '2026-11-02')
  })

  it('shows a set document date', async () => {
    await openEditor({ data: { documentDate: '2026-10-02' } })
    expect(
      screen.getByRole('button', { name: 'Dokumentdatum 02.10.2026 ändern' })
    ).toHaveTextContent('02.10.2026')
  })

  it('has no document date for recordings', async () => {
    await openEditor({ data: { sessionType: 'audio' } })
    expect(screen.queryByRole('button', { name: /Dokumentdatum/ })).not.toBeInTheDocument()
  })
})
