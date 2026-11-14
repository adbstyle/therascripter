import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AppShell from '../../shell/AppShell'
import { renderWithProviders } from '../../../test/renderWithProviders'
import { createMockApi, emitApiEvent } from '../../../test/mockApi'
import { makeDossier, makeTimelineEntry } from '../../../test/dossierFixtures'
import type { RecordingStartResult } from '../../../../../shared/types/IpcApi'

/**
 * #206 — Aufnahme und Import aus einem Patientendossier heraus, durch die
 * ganze Shell (Kopf der Dossier-Seite → WorkspaceActions → useRecording bzw.
 * `import.pdf`). Die Aufnahme selbst ist gemockt (kein getUserMedia in jsdom).
 */

const rec = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  const store = {
    recording: false,
    dossierId: null as string | null,
    nextAssignment: 'assigned' as 'none' | 'assigned' | 'failed',
    set(value: boolean, dossierId: string | null = null) {
      store.recording = value
      store.dossierId = value ? dossierId : null
      listeners.forEach((l) => l())
    },
    subscribe(l: () => void) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    get: () => store.recording
  }
  return store
})

vi.mock('../../../hooks/useRecording', async () => {
  const { useSyncExternalStore } = await import('react')
  const { createValueStore } = await import('../../../utils/valueStore')
  const startRecording = vi.fn(
    async (options?: { dossierId?: string }): Promise<RecordingStartResult> => {
      const assignment = options?.dossierId ? rec.nextAssignment : 'none'
      rec.set(true, assignment === 'assigned' ? (options?.dossierId ?? null) : null)
      return { sessionId: 'rec-1', assignment }
    }
  )
  const stopRecording = vi.fn(async () => rec.set(false))
  const level = createValueStore(0)
  const duration = createValueStore(0)
  return {
    __mocks: { startRecording },
    useRecording: () => {
      const isRecording = useSyncExternalStore(rec.subscribe, rec.get)
      return {
        isRecording,
        sessionId: isRecording ? 'rec-1' : null,
        dossierId: isRecording ? rec.dossierId : null,
        level,
        duration,
        error: null,
        startRecording,
        stopRecording
      }
    }
  }
})

const startMock = async (): Promise<ReturnType<typeof vi.fn>> =>
  (
    (await import('../../../hooks/useRecording')) as unknown as {
      __mocks: { startRecording: ReturnType<typeof vi.fn> }
    }
  ).__mocks.startRecording

const dossier = makeDossier()
const liveEntry = makeTimelineEntry({
  id: 'rec-1',
  title: 'Aufnahme 14.11.2026 10:05',
  status: 'recording'
})

function setup(options: { assigned: boolean }) {
  window.api = createMockApi({
    dossiers: {
      get: vi.fn().mockResolvedValue(dossier),
      list: vi.fn().mockResolvedValue([]),
      // Der Verlauf enthält die Aufnahme nur, wenn sie zugeordnet wurde
      timeline: vi.fn(async () => (rec.recording && options.assigned ? [liveEntry] : [])),
      listForSession: vi.fn(async (sessionId: string) =>
        rec.recording && options.assigned && sessionId === 'rec-1'
          ? [{ id: 'd1', firstName: 'Lukas', lastName: 'Hofer', externalId: null, birthDate: null }]
          : []
      )
    }
  })
  renderWithProviders(<AppShell />, { route: { kind: 'dossier', dossierId: 'd1' } })
  return userEvent.setup()
}

async function headerButton(name: string): Promise<HTMLElement> {
  const header = await screen.findByRole('heading', { name: 'Lukas Hofer' })
  const pageHeader = header.closest('header') ?? header.parentElement!.parentElement!
  return within(pageHeader as HTMLElement).getByRole('button', { name })
}

beforeEach(() => {
  vi.clearAllMocks()
  rec.set(false)
  rec.nextAssignment = 'assigned'
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Aufnahme aus dem Patientendossier (#206 AK 1, PC 1)', () => {
  it('startet mit dem Dossier, bleibt auf der Seite und zeigt die Live-Karte im Verlauf', async () => {
    const user = setup({ assigned: true })
    await user.click(await headerButton('Aufnahme starten'))

    expect(await startMock()).toHaveBeenCalledWith({ dossierId: 'd1' })
    // Main meldet die neue, zugeordnete Sitzung (createSession + assign)
    act(() => emitApiEvent(window.api, 'sessions.onChanged', { deletedIds: [] }))
    // Bleibt auf der Dossier-Seite …
    expect(await screen.findByRole('heading', { name: 'Lukas Hofer' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Transkriptionen' })).not.toBeInTheDocument()
    // … der Verlauf zeigt die Live-Karte, deshalb keine Aufnahme-Leiste doppelt
    const timeline = screen.getByRole('region', { name: 'Verlauf' })
    expect(
      await within(timeline).findByRole('button', { name: 'Aufnahme stoppen' })
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Zur laufenden Aufnahme wechseln' })
      ).not.toBeInTheDocument()
    )
    // Consent-Hinweis wie auf der Sitzungsliste
    expect(screen.getByRole('button', { name: 'Hinweis schliessen' })).toBeInTheDocument()
  })

  it('blockiert eine zweite Aufnahme: «Aufnahme starten» fehlt im Kopf, in der Seitenleiste ist es gesperrt', async () => {
    const user = setup({ assigned: true })
    await user.click(await headerButton('Aufnahme starten'))
    await screen.findByRole('button', { name: 'Hinweis schliessen' })
    const header = screen.getByRole('heading', { name: 'Lukas Hofer' }).parentElement!
      .parentElement!
    expect(within(header).queryByRole('button', { name: 'Aufnahme starten' })).toBeNull()
    const nav = screen.getByRole('navigation', { name: 'Seitenleiste' })
    expect(within(nav).getByRole('button', { name: 'Aufnahme läuft bereits' })).toBeDisabled()
    expect(await startMock()).toHaveBeenCalledTimes(1)
  })

  it('nennt Zeitpunkt und Dossier, wenn die Zuordnung scheitert — die Aufnahme läuft (AK 2)', async () => {
    rec.nextAssignment = 'failed'
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 10, 14, 10, 5, 30))
    const user = setup({ assigned: false })
    await user.click(await headerButton('Aufnahme starten'))

    expect(
      await screen.findByText(
        'Die Aufnahme vom 14.11.2026, 10:05 läuft, konnte dem Patientendossier «Hofer, Lukas» aber nicht zugeordnet werden. Sie können das in der Liste «Transkriptionen» über «Dossier zuordnen» nachholen.'
      )
    ).toBeInTheDocument()
    // Nicht im Verlauf dieses Dossiers → die Aufnahme-Leiste führt zur Aufnahme
    expect(
      await screen.findByRole('button', { name: 'Zur laufenden Aufnahme wechseln' })
    ).toBeInTheDocument()
  })
})

describe('Import aus dem Patientendossier (#206 AK 1, PC 2)', () => {
  it('importiert mit dem Dossier', async () => {
    const user = setup({ assigned: true })
    window.api.import.showPDFDialog = vi.fn().mockResolvedValue(['/tmp/bericht.pdf'])
    await user.click(await headerButton('PDF importieren'))
    await waitFor(() =>
      expect(window.api.import.pdf).toHaveBeenCalledWith(['/tmp/bericht.pdf'], { dossierId: 'd1' })
    )
    expect(screen.queryByText(/nicht zugeordnet/)).not.toBeInTheDocument()
  })

  it('nennt jedes PDF, das nicht zugeordnet werden konnte (AK 2)', async () => {
    const user = setup({ assigned: true })
    window.api.import.showPDFDialog = vi.fn().mockResolvedValue(['/tmp/a.pdf', '/tmp/b.pdf'])
    window.api.import.pdf = vi.fn().mockResolvedValue({
      sessions: [],
      unassigned: [
        { sessionId: 'p1', title: 'Austrittsbericht' },
        { sessionId: 'p2', title: 'Zuweisung' }
      ]
    })
    await user.click(await headerButton('PDF importieren'))
    expect(
      await screen.findByText(
        'Die PDF-Dokumente «Austrittsbericht», «Zuweisung» wurden importiert, konnten dem Patientendossier «Hofer, Lukas» aber nicht zugeordnet werden. Sie können das in der Liste «Transkriptionen» über «Dossier zuordnen» nachholen.'
      )
    ).toBeInTheDocument()
  })

  it('fragt ausserhalb eines Dossiers nach keinem Dossier (OOS 1)', async () => {
    const user = setup({ assigned: true })
    window.api.import.showPDFDialog = vi.fn().mockResolvedValue(['/tmp/a.pdf'])
    const nav = await screen.findByRole('navigation', { name: 'Seitenleiste' })
    await user.click(within(nav).getByRole('button', { name: 'PDF importieren' }))
    await waitFor(() => expect(window.api.import.pdf).toHaveBeenCalledWith(['/tmp/a.pdf']))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
