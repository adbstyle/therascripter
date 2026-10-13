import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ToolsBlockedBanner from '../ToolsBlockedBanner'

const state = {
  status: 'blocked' as const,
  tools: ['whisper' as const, 'llama' as const],
  bundlePath: '/Applications/Therascript.app'
}

describe('ToolsBlockedBanner (#168)', () => {
  it('nennt die betroffenen Funktionen und den Weg ohne Terminal (AK 2, 3, 5)', async () => {
    const onOpenGuide = vi.fn()
    render(
      <ToolsBlockedBanner
        state={state}
        checking={false}
        onOpenGuide={onOpenGuide}
        onRecheck={vi.fn()}
        onDismiss={vi.fn()}
      />
    )
    expect(screen.getByText(/Betroffen: Transkription, Zusammenfassung/)).toBeInTheDocument()
    expect(screen.getByText(/Dennoch öffnen/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Anleitung öffnen' }))
    expect(onOpenGuide).toHaveBeenCalledOnce()
  })

  it('zeigt den Terminal-Befehl erst unter «Hilft das nicht?» (AK 4)', async () => {
    render(
      <ToolsBlockedBanner
        state={state}
        checking={false}
        onOpenGuide={vi.fn()}
        onRecheck={vi.fn()}
        onDismiss={vi.fn()}
      />
    )
    expect(screen.queryByText(/xattr/)).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Hilft das nicht?' }))
    expect(
      screen.getByText(/xattr -dr com\.apple\.quarantine "\/Applications\/Therascript\.app"/)
    ).toBeInTheDocument()
  })

  it('kommt ohne Fachbegriffe aus (NFR 2)', () => {
    const { container } = render(
      <ToolsBlockedBanner
        state={state}
        checking={false}
        onOpenGuide={vi.fn()}
        onRecheck={vi.fn()}
        onDismiss={vi.fn()}
      />
    )
    expect(container.textContent).not.toMatch(/Gatekeeper|Quarantäne|quarantine/i)
  })
})
