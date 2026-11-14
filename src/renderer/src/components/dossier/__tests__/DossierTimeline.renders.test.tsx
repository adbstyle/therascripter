import { describe, it, expect, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

/**
 * Review #223 — ein Änderungs-Event ohne Änderung am Verlauf (z. B. Autosave
 * eines Namens in den Stammdaten) baut keine Karte neu auf. Gezählt wird über
 * den Statusblock, der nur rendert, wenn seine Karte rendert.
 */
const renders = vi.hoisted(() => ({ count: 0 }))
vi.mock('../../session/SessionStatusBlock', () => ({
  SessionStatusBlock: () => {
    renders.count++
    return null
  }
}))

import { DossierTimeline } from '../DossierTimeline'
import { createMockApi, emitApiEvent } from '../../../test/mockApi'
import { makeTimelineEntry } from '../../../test/dossierFixtures'
import { ToastProvider } from '../../../contexts/ToastContext'
import { NavigationProvider } from '../../../navigation/NavigationContext'
import { RecordingContext, type RecordingState } from '../../../contexts/recording'
import { createValueStore } from '../../../utils/valueStore'

const recording = {
  isRecording: false,
  sessionId: null,
  recordingDossierId: null,
  level: createValueStore(0),
  duration: createValueStore(0),
  startRecording: vi.fn(),
  stopRecording: vi.fn(),
  microphone: {} as RecordingState['microphone'],
  consentDismissed: false,
  dismissConsent: vi.fn()
} satisfies RecordingState

describe('DossierTimeline — structural sharing', () => {
  it('re-renders no card on an event without change, only the changed one otherwise', async () => {
    let titleOf42 = 'Sitzung 42'
    // Jede Abfrage liefert NEUE Objekte (wie über IPC)
    const timeline = vi.fn(async () =>
      Array.from({ length: 300 }, (_, i) =>
        makeTimelineEntry({
          id: `e${i}`,
          title: i === 42 ? titleOf42 : `Sitzung ${i}`,
          titlePlain: i === 42 ? titleOf42 : `Sitzung ${i}`,
          sortDay: '2026-11-10'
        })
      )
    )
    window.api = createMockApi({ dossiers: { timeline } })
    render(<DossierTimeline dossierId="d1" />, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <ToastProvider>
          <NavigationProvider initialRoute={{ kind: 'dossier', dossierId: 'd1' }}>
            <RecordingContext.Provider value={recording}>{children}</RecordingContext.Provider>
          </NavigationProvider>
        </ToastProvider>
      )
    })
    await screen.findByText('Sitzung 299')
    await waitFor(() => expect(timeline).toHaveBeenCalledTimes(1))

    renders.count = 0
    await act(async () => emitApiEvent(window.api, 'dossiers.onChanged', { deletedIds: [] }))
    await waitFor(() => expect(timeline).toHaveBeenCalledTimes(2))
    expect(renders.count).toBe(0)

    titleOf42 = 'Neuer Titel'
    await act(async () => emitApiEvent(window.api, 'sessions.onChanged', { deletedIds: [] }))
    await screen.findByText('Neuer Titel')
    expect(renders.count).toBe(1)
  })
})
