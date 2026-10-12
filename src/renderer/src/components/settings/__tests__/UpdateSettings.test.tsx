import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import UpdateSettings from '../UpdateSettings'
import type { AppUpdateState } from '../../../../../shared/types/AppUpdate'

const base: AppUpdateState = {
  phase: 'idle',
  currentVersion: '1.0.0',
  version: null,
  sizeBytes: null,
  progress: null,
  manualDownload: false,
  autoUpdate: true,
  installPending: false,
  message: null,
  unsupportedReason: null,
  checkedAt: '2026-10-12T10:00:00Z',
  checkFailed: false
}

const api = {
  getState: vi.fn(),
  check: vi.fn(),
  download: vi.fn(),
  cancelDownload: vi.fn(),
  install: vi.fn(),
  setAutoUpdate: vi.fn(),
  openInstallGuide: vi.fn(),
  onState: vi.fn().mockReturnValue(() => {})
}

function show(state: Partial<AppUpdateState>): void {
  api.getState.mockResolvedValue({ ...base, ...state })
  render(<UpdateSettings />)
}

beforeEach(() => {
  vi.clearAllMocks()
  api.onState.mockReturnValue(() => {})
  window.api = { appUpdate: api } as unknown as typeof window.api
})

describe('UpdateSettings', () => {
  it('zeigt den Schalter und erklärt beim Ausschalten, dass Fixes erst auf Klick kommen (#165)', async () => {
    show({ autoUpdate: false })
    const toggle = await screen.findByRole('switch', { name: 'Automatische Updates' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByText(/Fehlerbehebungen kommen erst an/)).toBeInTheDocument()

    await userEvent.click(toggle)
    expect(api.setAutoUpdate).toHaveBeenCalledWith(true)
  })

  it('nennt Version und Grösse vor dem Download (AK 4)', async () => {
    show({ phase: 'available', version: '1.1.0', sizeBytes: 300 * 1024 * 1024, autoUpdate: false })
    const button = await screen.findByRole('button', {
      name: /Version 1\.1\.0 herunterladen \(300/
    })
    await userEvent.click(button)
    expect(api.download).toHaveBeenCalledOnce()
  })

  it('zeigt Fortschritt und Abbrechen bei einem selbst gestarteten Download (AK 3)', async () => {
    show({ phase: 'downloading', version: '1.1.0', progress: 42, manualDownload: true })
    expect(await screen.findByRole('progressbar')).toHaveAttribute('aria-valuenow', '42')
    await userEvent.click(screen.getByRole('button', { name: 'Abbrechen' }))
    expect(api.cancelDownload).toHaveBeenCalledOnce()
  })

  it('bietet ein bereitliegendes Update zur Installation an', async () => {
    show({ phase: 'ready', version: '1.1.0' })
    await userEvent.click(await screen.findByRole('button', { name: 'Version 1.1.0 installieren' }))
    expect(api.install).toHaveBeenCalledOnce()
  })

  it('zeigt eine vorgemerkte Installation als Hinweis statt Knopf (AK 15)', async () => {
    show({
      phase: 'ready',
      version: '1.1.0',
      installPending: true,
      message: 'Das Update wird installiert, sobald die Aufnahme beendet ist.'
    })
    expect(await screen.findByText(/sobald die Aufnahme beendet ist/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /installieren/ })).not.toBeInTheDocument()
  })

  it('erklärt, warum sich die App nicht ersetzen kann, und öffnet die Anleitung (AK 9)', async () => {
    show({
      phase: 'unsupported',
      version: '1.1.0',
      unsupportedReason: 'Therascript läuft nicht aus dem Ordner «Programme».'
    })
    expect(await screen.findByText(/nicht aus dem Ordner «Programme»/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Anleitung öffnen' }))
    expect(api.openInstallGuide).toHaveBeenCalledOnce()
  })

  it('meldet «aktuell» nur nach einer gelungenen Prüfung', async () => {
    show({ checkFailed: true })
    expect(await screen.findByText(/Suche nach Updates ist nicht gelungen/)).toBeInTheDocument()
    expect(screen.queryByText(/ist aktuell/)).not.toBeInTheDocument()
  })

  it('meldet «aktuell» nicht, solange noch keine Prüfung gelungen ist', async () => {
    show({ checkedAt: null })
    expect(await screen.findByText(/Noch nicht nach Updates gesucht/)).toBeInTheDocument()
    expect(screen.queryByText(/ist aktuell/)).not.toBeInTheDocument()
  })

  it('zeigt eine gescheiterte Installation als Status (AK 16)', async () => {
    show({
      phase: 'ready',
      version: '1.1.0',
      message:
        'Die Installation von Version 1.1.0 ist nicht gelungen. Therascript versucht es automatisch erneut.'
    })
    expect(await screen.findByRole('status')).toHaveTextContent(/automatisch erneut/)
  })
})
