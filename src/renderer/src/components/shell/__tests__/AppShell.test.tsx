import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef } from 'react'
import AppShell from '../AppShell'
import { renderWithProviders } from '../../../test/renderWithProviders'
import { createMockApi, emitApiEvent, IDLE_APP_UPDATE, makeSession } from '../../../test/mockApi'
import { useRecordingState } from '../../../contexts/recording'
import type { Route } from '../../../navigation/routes'

// Aufnahme steuerbar ohne getUserMedia/AudioWorklet: ein kleiner Store, den
// startRecording/stopRecording umschalten. Pegel und Dauer bleiben ValueStores.
const rec = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  const store = {
    recording: false,
    set(value: boolean) {
      store.recording = value
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
  const { useState, useSyncExternalStore } = await import('react')
  const { createValueStore } = await import('../../../utils/valueStore')
  const startRecording = vi.fn(async () => rec.set(true))
  const stopRecording = vi.fn(async () => rec.set(false))
  const level = createValueStore(0)
  const duration = createValueStore(0)
  return {
    __mocks: { startRecording, stopRecording, level, duration },
    useRecording: () => {
      const isRecording = useSyncExternalStore(rec.subscribe, rec.get)
      const [error] = useState<string | null>(null)
      return {
        isRecording,
        sessionId: isRecording ? 'rec-1' : null,
        level,
        duration,
        error,
        startRecording,
        stopRecording
      }
    }
  }
})

// Editor durch eine schlanke Attrappe ersetzen: hier geht es um die Navigation
vi.mock('../../../views/ReviewEditor', () => ({
  default: ({ sessionId, onBack }: { sessionId: string; onBack: () => void }) => (
    <div>
      <p>Editor {sessionId}</p>
      <button onClick={onBack}>Editor verlassen</button>
    </div>
  )
}))

const recordingMocks = async () =>
  (
    (await import('../../../hooks/useRecording')) as unknown as {
      __mocks: {
        startRecording: ReturnType<typeof vi.fn>
        duration: { set: (v: number) => void }
      }
    }
  ).__mocks

const recordingSession = makeSession({ id: 'rec-1', title: 'Aufnahme', status: 'recording' })
const reviewSession = makeSession({ id: 's1', title: 'Erstgespräch' })

function renderShell(route?: Route) {
  return renderWithProviders(<AppShell />, { route })
}

beforeEach(() => {
  rec.set(false)
  window.api = createMockApi({
    sessions: { list: vi.fn().mockResolvedValue([reviewSession]) }
  })
  Element.prototype.scrollIntoView = vi.fn()
})

describe('AppShell — Seitenleiste und Titelleiste', () => {
  it('zeigt die Seitenleiste als benannte Navigation mit aktivem Eintrag', async () => {
    renderShell()
    const nav = await screen.findByRole('navigation', { name: 'Seitenleiste' })
    const transcriptions = within(nav).getByRole('button', { name: 'Transkriptionen' })
    expect(transcriptions).toHaveAttribute('aria-current', 'page')
    expect(within(nav).getByRole('button', { name: 'Einstellungen' })).not.toHaveAttribute(
      'aria-current'
    )
    expect(within(nav).getByRole('button', { name: 'Alle Patientendossiers' })).not.toHaveAttribute(
      'aria-current'
    )
  })

  it('beschriftet jeden Icon-Knopf und gibt ihm einen Tooltip', async () => {
    renderShell()
    const nav = await screen.findByRole('navigation', { name: 'Seitenleiste' })
    const banner = screen.getByRole('banner', { name: 'TheraScript' })
    const iconButtons = [
      ...within(banner)
        .getAllByRole('button')
        .filter((b) => !b.closest('[role="group"]')),
      within(nav).getByRole('button', { name: 'PDF importieren' }),
      within(nav).getByRole('button', { name: 'Aufnahme starten' }),
      within(nav).getByRole('button', { name: 'Neues Patientendossier' })
    ]
    expect(iconButtons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Seitenleiste',
      'Zurück',
      'Vorwärts',
      'PDF importieren',
      'Aufnahme starten',
      'Neues Patientendossier'
    ])
    for (const button of iconButtons) {
      expect(button.textContent).toBe('')
      expect(button.getAttribute('title')).toContain(button.getAttribute('aria-label'))
    }
    expect(iconButtons[0]).toHaveAttribute('title', 'Seitenleiste ein-/ausblenden (⌃⌘S)')
  })

  it('hält die Titelleiste als Zieh-Bereich und nimmt alle Knöpfe davon aus', async () => {
    renderShell()
    const banner = await screen.findByRole('banner', { name: 'TheraScript' })
    expect(banner).toHaveClass('titlebar-drag')
    const buttons = within(banner).getAllByRole('button')
    expect(buttons.length).toBeGreaterThanOrEqual(5)
    for (const button of buttons) {
      expect(button.closest('.titlebar-no-drag')).not.toBeNull()
    }
  })

  it('hält die min-h-0-Flex-Kette bis zum einzigen Scroll-Container', async () => {
    renderShell()
    const scroll = await screen.findByTestId('page-scroll')
    expect(scroll).toHaveClass('min-h-0', 'flex-1', 'overflow-y-auto')
    let node = scroll.parentElement
    while (node && !node.classList.contains('h-screen')) {
      expect(node).toHaveClass('min-h-0')
      node = node.parentElement
    }
    expect(node).not.toBeNull()
  })

  it('blendet die Seitenleiste per Knopf und per Menübefehl aus und ein und speichert das', async () => {
    const user = userEvent.setup()
    renderShell()
    await screen.findByRole('navigation', { name: 'Seitenleiste' })

    const toggle = screen.getByRole('button', { name: 'Seitenleiste' })
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await user.click(toggle)
    expect(screen.queryByRole('navigation', { name: 'Seitenleiste' })).not.toBeInTheDocument()
    expect(window.api.settings.set).toHaveBeenCalledWith('sidebarOpen', false)
    expect(screen.getByRole('button', { name: 'Seitenleiste' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )

    act(() => emitApiEvent(window.api, 'nav.onCommand', 'toggleSidebar'))
    expect(screen.getByRole('navigation', { name: 'Seitenleiste' })).toBeInTheDocument()
    expect(window.api.settings.set).toHaveBeenLastCalledWith('sidebarOpen', true)
  })

  it('startet ohne Aufblitzen mit der gespeicherten, synchron gelesenen Einstellung', () => {
    window.api = createMockApi({
      sessions: { list: vi.fn().mockResolvedValue([reviewSession]) },
      nav: { initialSidebarOpen: false }
    })
    renderShell()
    // Schon im ersten Render — ohne auf eine Antwort zu warten
    expect(screen.queryByRole('navigation', { name: 'Seitenleiste' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Seitenleiste' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
    expect(window.api.settings.get).not.toHaveBeenCalledWith('sidebarOpen')
  })

  it('zeigt die Seitenleiste ohne gespeicherten Wert sofort an', () => {
    renderShell()
    expect(screen.getByRole('navigation', { name: 'Seitenleiste' })).toBeInTheDocument()
  })

  it('geht mit ‹ und › durch die besuchten Seiten', async () => {
    const user = userEvent.setup()
    renderShell()
    const back = await screen.findByRole('button', { name: 'Zurück' })
    expect(back).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'Einstellungen' }))
    expect(await screen.findByRole('heading', { name: 'Einstellungen' })).toBeInTheDocument()

    await user.click(back)
    expect(await screen.findByRole('heading', { name: 'Transkriptionen' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Vorwärts' }))
    expect(await screen.findByRole('heading', { name: 'Einstellungen' })).toBeInTheDocument()
  })

  it('ist per Tastatur bedienbar', async () => {
    const user = userEvent.setup()
    renderShell()
    await screen.findByRole('navigation', { name: 'Seitenleiste' })
    const settings = screen.getByRole('button', { name: 'Einstellungen' })
    settings.focus()
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('heading', { name: 'Einstellungen' })).toBeInTheDocument()
  })

  it('führt über «Alle Patientendossiers» zur Übersicht und hält den Eintrag auf der Dossier-Seite aktiv (#204)', async () => {
    const user = userEvent.setup()
    window.api = createMockApi({
      dossiers: {
        list: vi.fn().mockResolvedValue([
          {
            id: 'd1',
            firstName: 'Lukas',
            lastName: 'Hofer',
            externalId: 'PD-1188',
            birthDate: '1978-02-03',
            entryCount: 0,
            lastEntryDay: null
          }
        ]),
        get: vi.fn().mockResolvedValue({
          id: 'd1',
          firstName: 'Lukas',
          lastName: 'Hofer',
          externalId: 'PD-1188',
          birthDate: '1978-02-03',
          diagnoses: '',
          medication: '',
          note: '',
          createdAt: '2026-11-01T10:00:00.000Z',
          updatedAt: '2026-11-01T10:00:00.000Z'
        })
      }
    })
    renderShell()
    const nav = await screen.findByRole('navigation', { name: 'Seitenleiste' })
    const entry = within(nav).getByRole('button', { name: 'Alle Patientendossiers' })
    await user.click(entry)
    expect(await screen.findByRole('heading', { name: 'Patientendossiers' })).toBeInTheDocument()
    expect(entry).toHaveAttribute('aria-current', 'page')
    expect(entry.parentElement).toHaveClass('bg-surface-2')

    await user.click(await screen.findByRole('button', { name: /Hofer, Lukas/ }))
    expect(await screen.findByRole('heading', { name: 'Lukas Hofer' })).toBeInTheDocument()
    // Auf der Dossier-Seite bleibt der Bereich hervorgehoben, ist aber nicht «die» Seite
    expect(entry.parentElement).toHaveClass('bg-surface-2')
    expect(entry).not.toHaveAttribute('aria-current')
  })

  it('öffnet «Neues Patientendossier» über das + in der Seitenleiste und führt danach zum Dossier (#204)', async () => {
    const user = userEvent.setup()
    const created = {
      id: 'd-new',
      firstName: 'Anna',
      lastName: 'Meier',
      externalId: null,
      birthDate: null,
      diagnoses: '',
      medication: '',
      note: '',
      createdAt: '2026-11-01T10:00:00.000Z',
      updatedAt: '2026-11-01T10:00:00.000Z'
    }
    window.api = createMockApi({
      dossiers: {
        create: vi.fn().mockResolvedValue({ ok: true, dossier: created }),
        get: vi.fn().mockResolvedValue(created)
      }
    })
    renderShell()
    const nav = await screen.findByRole('navigation', { name: 'Seitenleiste' })
    await user.click(within(nav).getByRole('button', { name: 'Neues Patientendossier' }))
    const dialog = await screen.findByRole('dialog', { name: 'Neues Patientendossier' })
    await user.type(within(dialog).getByLabelText(/Vorname/), 'Anna')
    await user.type(within(dialog).getByLabelText(/Nachname/), 'Meier')
    await user.click(within(dialog).getByRole('button', { name: 'Anlegen' }))

    expect(await screen.findByRole('heading', { name: 'Anna Meier' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(await screen.findByText('Patientendossier angelegt')).toBeInTheDocument()
  })
})

describe('AppShell — Verhalten wie vor dem Umbau', () => {
  it('führt beim Aufnahmestart zur Sitzungsliste', async () => {
    const user = userEvent.setup()
    renderShell({ kind: 'settings', subpage: 'darstellung' })
    await screen.findByRole('heading', { name: 'Darstellung' })

    window.api.sessions.list = vi.fn().mockResolvedValue([recordingSession, reviewSession])
    await user.click(screen.getByRole('button', { name: 'Aufnahme starten' }))

    expect((await recordingMocks()).startRecording).toHaveBeenCalled()
    expect(await screen.findByRole('heading', { name: 'Transkriptionen' })).toBeInTheDocument()
  })

  it('zeigt die Aufnahme-Leiste überall ausser auf der Sitzungsliste', async () => {
    const user = userEvent.setup()
    rec.set(true)
    window.api.sessions.list = vi.fn().mockResolvedValue([recordingSession, reviewSession])
    renderShell()
    await screen.findByRole('heading', { name: 'Transkriptionen' })
    expect(screen.queryByLabelText('Zur laufenden Aufnahme wechseln')).not.toBeInTheDocument()

    // Einstellungen
    await user.click(screen.getByRole('button', { name: 'Einstellungen' }))
    const bar = await screen.findByLabelText('Zur laufenden Aufnahme wechseln')

    // Zurück zur Liste über die Leiste
    await user.click(bar)
    await screen.findByRole('heading', { name: 'Transkriptionen' })
    expect(screen.queryByLabelText('Zur laufenden Aufnahme wechseln')).not.toBeInTheDocument()

    // Sitzung im Editor
    await user.click(await screen.findByRole('button', { name: 'Erstgespräch öffnen' }))
    await screen.findByText('Editor s1')
    expect(screen.getByLabelText('Zur laufenden Aufnahme wechseln')).toBeInTheDocument()
  })

  it('zeigt den Consent-Hinweis einmal pro Aufnahme, auch nach einem Seitenwechsel nicht wieder', async () => {
    const user = userEvent.setup()
    window.api.settings.get = vi.fn(async (key: string) =>
      key === 'consentReminderShown' ? false : undefined
    )
    window.api.sessions.list = vi.fn().mockResolvedValue([recordingSession])
    renderShell()
    await screen.findByRole('heading', { name: 'Transkriptionen' })

    await user.click(screen.getAllByRole('button', { name: 'Aufnahme starten' })[0])
    expect(await screen.findByText(/StGB/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Hinweis schliessen' }))
    expect(screen.queryByText(/StGB/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Einstellungen' }))
    await screen.findByRole('heading', { name: 'Einstellungen' })
    await user.click(screen.getByLabelText('Zur laufenden Aufnahme wechseln'))
    await screen.findByRole('heading', { name: 'Transkriptionen' })
    expect(screen.queryByText(/StGB/)).not.toBeInTheDocument()

    // Neue Aufnahme: der Hinweis kommt wieder
    act(() => rec.set(false))
    await user.click(screen.getAllByRole('button', { name: 'Aufnahme starten' })[0])
    expect(await screen.findByText(/StGB/)).toBeInTheDocument()
  })

  it('öffnet die Einstellungen über App-Menü und Tray, immer auf der Übersicht', async () => {
    renderShell({ kind: 'settings', subpage: 'updates' })
    await screen.findByRole('heading', { name: 'Updates' })
    act(() => emitApiEvent(window.api, 'nav.onOpenSettings'))
    expect(await screen.findByRole('heading', { name: 'Einstellungen' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Updates' })).not.toBeInTheDocument()
  })

  it('führt vom Update-Hinweis zu Einstellungen › Updates', async () => {
    const user = userEvent.setup()
    window.api.appUpdate.getState = vi
      .fn()
      .mockResolvedValue({ ...IDLE_APP_UPDATE, phase: 'ready', version: '0.11.0' })
    renderShell()
    await user.click(await screen.findByRole('button', { name: 'Update bereit' }))
    expect(await screen.findByRole('heading', { name: 'Updates' })).toBeInTheDocument()
  })

  it('zeigt ohne Update die Versionsnummer', async () => {
    renderShell()
    expect(await screen.findByText('v0.10.1')).toBeInTheDocument()
  })

  it('hebt nach dem Schliessen des Editors die zuletzt geöffnete Karte hervor', async () => {
    const user = userEvent.setup()
    renderShell()
    await user.click(await screen.findByRole('button', { name: 'Erstgespräch öffnen' }))
    await user.click(await screen.findByRole('button', { name: 'Editor verlassen' }))

    await screen.findByRole('heading', { name: 'Transkriptionen' })
    await waitFor(() => {
      const card = document.querySelector('[data-session-id="s1"]')
      expect(card).toHaveClass('session-highlight')
    })
  })

  it('kehrt ohne Verlauf aus dem Editor zur Sitzungsliste zurück', async () => {
    const user = userEvent.setup()
    renderShell({ kind: 'session', sessionId: 's1' })
    await user.click(await screen.findByRole('button', { name: 'Editor verlassen' }))
    expect(await screen.findByRole('heading', { name: 'Transkriptionen' })).toBeInTheDocument()
  })

  it('schliesst eine im Editor gelöschte Sitzung und entfernt sie aus dem Verlauf', async () => {
    const user = userEvent.setup()
    renderShell()
    await user.click(await screen.findByRole('button', { name: 'Erstgespräch öffnen' }))
    await screen.findByText('Editor s1')

    act(() => emitApiEvent(window.api, 'sessions.onChanged', { deletedIds: ['s1'] }))
    await screen.findByRole('heading', { name: 'Transkriptionen' })
    expect(screen.getByRole('button', { name: 'Vorwärts' })).toBeDisabled()
  })

  it('importiert PDFs über den Knopf im Seitenkopf und in der Seitenleiste', async () => {
    const user = userEvent.setup()
    window.api.import.showPDFDialog = vi.fn().mockResolvedValue(['/tmp/a.pdf'])
    renderShell()
    await screen.findByRole('heading', { name: 'Transkriptionen' })

    const [sidebarButton, headerButton] = screen.getAllByRole('button', {
      name: 'PDF importieren'
    })
    await user.click(headerButton)
    await waitFor(() => expect(window.api.import.pdf).toHaveBeenCalledWith(['/tmp/a.pdf']))

    await user.click(sidebarButton)
    await waitFor(() => expect(window.api.import.pdf).toHaveBeenCalledTimes(2))
  })

  it('zeigt die Hinweise zu blockierten Werkzeugen und zum Mikrofon in der Inhaltsspalte', async () => {
    window.api.toolHealth.getState = vi.fn().mockResolvedValue({
      status: 'blocked',
      tools: ['python'],
      bundlePath: '/Applications/Therascript.app'
    })
    window.api.microphone.getState = vi
      .fn()
      .mockResolvedValue({ status: 'not-determined', previouslyGranted: true })
    renderShell()
    expect(await screen.findByText(/Betroffen:/)).toBeInTheDocument()
    expect(
      await screen.findByText(/braucht Therascript die Mikrofon-Berechtigung/)
    ).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Seitenleiste' })).not.toContainElement(
      screen.getByText(/Betroffen:/)
    )
  })

  it('rendert die Shell nicht bei jedem Pegel- oder Dauerwert neu (ValueStores)', async () => {
    rec.set(true)
    window.api.sessions.list = vi.fn().mockResolvedValue([recordingSession])
    let renders = 0
    function Probe(): null {
      useRecordingState()
      const count = useRef(0)
      count.current++
      renders = count.current
      return null
    }
    renderWithProviders(
      <>
        <AppShell />
        <Probe />
      </>,
      { route: { kind: 'settings', subpage: null } }
    )
    await screen.findByLabelText('Zur laufenden Aufnahme wechseln')
    const before = renders
    const { duration } = await recordingMocks()
    act(() => {
      for (let s = 1; s <= 30; s++) duration.set(s)
    })
    expect(screen.getByText('00:00:30')).toBeInTheDocument()
    expect(renders).toBe(before)
  })
})

describe('AppShell — Befunde aus dem Review', () => {
  it('zeigt bei eingeklappter Seitenleiste Update-Chip und Hinweispunkt in der Titelleiste', async () => {
    const user = userEvent.setup()
    window.api = createMockApi({
      sessions: { list: vi.fn().mockResolvedValue([reviewSession]) },
      nav: { initialSidebarOpen: false },
      appUpdate: {
        getState: vi
          .fn()
          .mockResolvedValue({ ...IDLE_APP_UPDATE, phase: 'ready', version: '0.11.0' })
      },
      modelReconcile: {
        getEvents: vi.fn().mockResolvedValue([{ id: 'e1', status: 'pending' }])
      }
    })
    renderShell()
    const banner = screen.getByRole('banner', { name: 'TheraScript' })
    const chip = await within(banner).findByRole('button', { name: 'Update bereit' })
    expect(
      await within(banner).findByRole('button', {
        name: 'Seitenleiste — Automatische Anpassung — Hinweis in Modelle'
      })
    ).toHaveAttribute('aria-pressed', 'false')

    await user.click(chip)
    expect(await screen.findByRole('heading', { name: 'Updates' })).toBeInTheDocument()

    // Eingeblendet: die Hinweise stehen wieder nur im Fuss der Seitenleiste
    await user.click(within(banner).getByRole('button', { name: /^Seitenleiste/ }))
    const nav = screen.getByRole('navigation', { name: 'Seitenleiste' })
    expect(within(banner).queryByRole('button', { name: 'Update bereit' })).not.toBeInTheDocument()
    expect(within(banner).getByRole('button', { name: 'Seitenleiste' })).toBeInTheDocument()
    expect(within(nav).getByRole('button', { name: 'Update bereit' })).toBeInTheDocument()
    expect(
      within(nav).getByLabelText('Automatische Anpassung — Hinweis in Modelle')
    ).toBeInTheDocument()
  })

  it('löst den Anker nur einmal ein — später zählt die gemerkte Position', async () => {
    const user = userEvent.setup()
    renderShell()
    await user.click(await screen.findByRole('button', { name: 'Erstgespräch öffnen' }))
    await user.click(await screen.findByRole('button', { name: 'Editor verlassen' }))
    await waitFor(() =>
      expect(document.querySelector('[data-session-id="s1"]')).toHaveClass('session-highlight')
    )

    // Weit scrollen, dann Einstellungen und zurück
    const scroll = screen.getByTestId('page-scroll')
    scroll.scrollTop = 800
    scroll.dispatchEvent(new Event('scroll'))
    const scrollIntoView = vi.mocked(Element.prototype.scrollIntoView)
    scrollIntoView.mockClear()
    await user.click(screen.getByRole('button', { name: 'Einstellungen' }))
    await screen.findByRole('heading', { name: 'Einstellungen' })
    await user.click(screen.getByRole('button', { name: 'Zurück' }))
    await screen.findByRole('button', { name: 'Erstgespräch öffnen' })

    expect(screen.getByTestId('page-scroll').scrollTop).toBe(800)
    expect(document.querySelector('[data-session-id="s1"]')).not.toHaveClass('session-highlight')
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('wechselt bei offenem Dialog nicht per Menübefehl die Seite', async () => {
    const user = userEvent.setup()
    renderShell()
    await user.click(await screen.findByRole('button', { name: 'Einstellungen' }))
    await screen.findByRole('heading', { name: 'Einstellungen' })

    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    document.body.appendChild(dialog)
    try {
      act(() => emitApiEvent(window.api, 'nav.onCommand', 'back'))
      act(() => emitApiEvent(window.api, 'nav.onCommand', 'toggleSidebar'))
      expect(screen.getByRole('heading', { name: 'Einstellungen' })).toBeInTheDocument()
      expect(screen.getByRole('navigation', { name: 'Seitenleiste' })).toBeInTheDocument()
    } finally {
      dialog.remove()
    }
    act(() => emitApiEvent(window.api, 'nav.onCommand', 'back'))
    expect(await screen.findByRole('heading', { name: 'Transkriptionen' })).toBeInTheDocument()
  })

  it('löst vor jedem Seitenwechsel den Fokus, damit Speichern-beim-Verlassen greift', async () => {
    const user = userEvent.setup()
    renderShell()
    await user.click(await screen.findByRole('button', { name: 'Erstgespräch öffnen' }))
    await screen.findByText('Editor s1')

    const input = document.createElement('input')
    const onBlur = vi.fn()
    input.addEventListener('blur', onBlur)
    document.body.appendChild(input)
    input.focus()
    try {
      act(() => emitApiEvent(window.api, 'nav.onCommand', 'back'))
      expect(onBlur).toHaveBeenCalledTimes(1)
      expect(await screen.findByRole('heading', { name: 'Transkriptionen' })).toBeInTheDocument()
    } finally {
      input.remove()
    }
  })
})
