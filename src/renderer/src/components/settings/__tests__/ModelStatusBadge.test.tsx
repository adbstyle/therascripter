import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import ModelStatusBadge, { deriveModelStatus } from '../ModelStatusBadge'

describe('deriveModelStatus', () => {
  it('returns "active" when active and installed', () => {
    expect(deriveModelStatus({ isActive: true, isInstalled: true })).toBe('active')
  })

  it('returns "installed" when installed but not active', () => {
    expect(deriveModelStatus({ isActive: false, isInstalled: true })).toBe('installed')
  })

  it('returns "missing" when neither active nor installed', () => {
    expect(deriveModelStatus({ isActive: false, isInstalled: false })).toBe('missing')
  })

  it('returns "inconsistent" when active but not installed (defense in depth)', () => {
    // Story C's reconciler clears this state at app start; the badge surfaces
    // it for the rare in-session case (e.g. user deletes the file in Finder
    // while the app is running).
    expect(deriveModelStatus({ isActive: true, isInstalled: false })).toBe('inconsistent')
  })
})

describe('<ModelStatusBadge>', () => {
  it('renders the label "Aktiv" for active status', () => {
    render(<ModelStatusBadge status="active" />)
    expect(screen.getByText('Aktiv')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveAttribute(
      'aria-label',
      expect.stringContaining('wird für neue Verarbeitungen verwendet')
    )
  })

  it('renders the label "Installiert" for installed status', () => {
    render(<ModelStatusBadge status="installed" />)
    expect(screen.getByText('Installiert')).toBeInTheDocument()
  })

  it('renders the label "Nicht installiert" for missing status', () => {
    render(<ModelStatusBadge status="missing" />)
    expect(screen.getByText('Nicht installiert')).toBeInTheDocument()
  })

  it('renders the locked label including the self-heal promise for inconsistent status', () => {
    render(<ModelStatusBadge status="inconsistent" />)
    expect(screen.getByText('Aktiv, aber fehlt — wird repariert')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveAttribute(
      'aria-label',
      expect.stringContaining('wird beim nächsten Start automatisch repariert')
    )
  })
})
