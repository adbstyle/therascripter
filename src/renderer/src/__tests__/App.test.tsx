import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import App from '../App'
import { ToastProvider } from '../contexts/ToastContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { createValueStore } from '../utils/valueStore'
import { createMockApi, makeSession } from '../test/mockApi'

// useRecording mocken: Aufnahme-Zustand pro Test steuerbar, ohne
// getUserMedia/AudioWorklet in jsdom simulieren zu müssen.
const mockRecordingState = {
  isRecording: false,
  sessionId: null as string | null,
  level: createValueStore(0),
  duration: createValueStore(0),
  error: null as string | null,
  startRecording: vi.fn(),
  stopRecording: vi.fn()
}
vi.mock('../hooks/useRecording', () => ({
  useRecording: () => mockRecordingState
}))

// Wie main.tsx: Theme und Toasts liegen ausserhalb von App
const renderApp = (): ReturnType<typeof render> =>
  render(
    <ThemeProvider>
      <ToastProvider>
        <App />
      </ToastProvider>
    </ThemeProvider>
  )

beforeEach(() => {
  mockRecordingState.isRecording = false
  mockRecordingState.sessionId = null
  mockRecordingState.duration = createValueStore(0)
  mockRecordingState.error = null
  window.api = createMockApi()
})

describe('App', () => {
  it('zeigt die Shell mit Seitenleiste, sobald die Modelle bereit sind', async () => {
    renderApp()
    expect(await screen.findByRole('navigation', { name: 'Seitenleiste' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Einstellungen' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Transkriptionen' })).toBeInTheDocument()
  })

  it('zeigt den Leerzustand ohne Transkriptionen', async () => {
    renderApp()
    expect(await screen.findByText('Keine Transkriptionen')).toBeInTheDocument()
  })

  it('zeigt die Ersteinrichtung ohne Seitenleiste und ohne Navigation', async () => {
    window.api.modelDownload.status = vi.fn().mockResolvedValue({
      modelsReady: false,
      models: [{ id: 'asr', label: 'Spracherkennung', sizeBytes: 1 }]
    })
    renderApp()
    await waitFor(() => expect(window.api.modelDownload.status).toHaveBeenCalled())
    await screen.findByRole('banner', { name: 'TheraScript' })
    await waitFor(() => expect(window.api.modelDownload.checkDiskSpace).toHaveBeenCalled())
    expect(screen.queryByRole('navigation', { name: 'Seitenleiste' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Zurück' })).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Ansicht' })).not.toBeInTheDocument()
  })
})

describe('App — Navigation während der Aufnahme', () => {
  it('bleibt während der Aufnahme navigierbar, nur «Aufnahme starten» ruht', async () => {
    mockRecordingState.isRecording = true
    renderApp()

    await screen.findByRole('navigation', { name: 'Seitenleiste' })
    expect(screen.getByRole('button', { name: 'Einstellungen' })).toBeEnabled()
    expect(screen.getByText('PDF importieren')).toBeInTheDocument()
    expect(screen.queryByText('Aufnahme starten')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Aufnahme läuft bereits' })).toBeDisabled()
  })

  it('rendert die Live-Karte für die Recording-Session in der Liste', async () => {
    mockRecordingState.isRecording = true
    mockRecordingState.duration.set(95)
    window.api.sessions.list = vi
      .fn()
      .mockResolvedValue([
        makeSession({ id: 'rec-1', title: 'Aufnahme 07.08.2026 14:02', status: 'recording' })
      ])

    renderApp()

    await waitFor(() => {
      expect(screen.getByText('REC')).toBeInTheDocument()
    })
    expect(screen.getByText('00:01:35')).toBeInTheDocument()
    expect(screen.getByLabelText('Aufnahme stoppen')).toBeInTheDocument()
    // Auf der Sitzungsliste keine RecordingBar (Karte übernimmt)
    expect(screen.queryByLabelText('Zur laufenden Aufnahme wechseln')).not.toBeInTheDocument()
  })

  it('zeigt die RecordingBar in den Einstellungen und navigiert per Klick zurück', async () => {
    const user = userEvent.setup()
    mockRecordingState.isRecording = true
    mockRecordingState.duration.set(61)

    renderApp()
    await user.click(await screen.findByRole('button', { name: 'Einstellungen' }))

    const bar = await screen.findByLabelText('Zur laufenden Aufnahme wechseln')
    expect(screen.getByText('Aufnahme läuft')).toBeInTheDocument()
    expect(screen.getByText('00:01:01')).toBeInTheDocument()

    await user.click(bar)

    await waitFor(() => {
      expect(screen.queryByLabelText('Zur laufenden Aufnahme wechseln')).not.toBeInTheDocument()
      expect(screen.getByText('PDF importieren')).toBeInTheDocument()
    })
  })

  it('zeigt Aufnahmefehler als Toast', async () => {
    mockRecordingState.error = 'Mikrofonzugriff wurde verweigert.'
    renderApp()

    await waitFor(() => {
      expect(screen.getByText('Mikrofonzugriff wurde verweigert.')).toBeInTheDocument()
    })
  })
})

describe('App — Mikrofon-Berechtigung (Issue #161)', () => {
  it('weist nach dem Start auf eine verlorene Berechtigung hin', async () => {
    window.api.microphone.getState = vi
      .fn()
      .mockResolvedValue({ status: 'not-determined', previouslyGranted: true })
    renderApp()

    expect(
      await screen.findByText(/braucht Therascript die Mikrofon-Berechtigung/)
    ).toBeInTheDocument()
  })

  it('zeigt den Hinweis nie während einer Aufnahme', async () => {
    mockRecordingState.isRecording = true
    window.api.microphone.getState = vi
      .fn()
      .mockResolvedValue({ status: 'not-determined', previouslyGranted: true })
    renderApp()

    await waitFor(() => expect(window.api.microphone.getState).toHaveBeenCalled())
    await screen.findByText('PDF importieren')
    expect(
      screen.queryByText(/braucht Therascript die Mikrofon-Berechtigung/)
    ).not.toBeInTheDocument()
  })
})

describe('App — blockierte Werkzeuge (Issue #168)', () => {
  const blocked = {
    status: 'blocked' as const,
    tools: ['python' as const],
    bundlePath: '/Applications/Therascript.app'
  }

  it('zeigt den Hinweis, wenn macOS Werkzeuge blockiert, und blendet ihn auf Wunsch aus', async () => {
    window.api.toolHealth.getState = vi.fn().mockResolvedValue(blocked)
    renderApp()
    expect(
      await screen.findByText(/Betroffen: Sprechererkennung und Pseudonymisierung/)
    ).toBeInTheDocument()
    await userEvent.click(screen.getAllByRole('button', { name: 'Hinweis schliessen' })[0])
    expect(screen.queryByText(/Betroffen:/)).not.toBeInTheDocument()
  })

  it('zeigt den Hinweis nie während einer Aufnahme', async () => {
    mockRecordingState.isRecording = true
    window.api.toolHealth.getState = vi.fn().mockResolvedValue(blocked)
    renderApp()
    await waitFor(() => expect(window.api.toolHealth.getState).toHaveBeenCalled())
    await screen.findByText('PDF importieren')
    expect(screen.queryByText(/Betroffen:/)).not.toBeInTheDocument()
  })
})
