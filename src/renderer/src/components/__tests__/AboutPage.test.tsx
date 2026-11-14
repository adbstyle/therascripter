import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import AboutPage from '../AboutPage'

beforeEach(() => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      system: { aboutInfo: vi.fn().mockResolvedValue(null) },
      appUpdate: {
        getStatus: vi.fn().mockResolvedValue(null),
        onStatus: vi.fn().mockReturnValue(() => {})
      }
    }
  })
})

describe('AboutPage', () => {
  it('lists software and models with their license in Acknowledgments', () => {
    render(<AboutPage />)

    expect(screen.getByText('whisper.cpp')).toBeInTheDocument()
    expect(screen.getByText('Gemma 4 E2B')).toBeInTheDocument()
    for (const google of screen.getAllByText(/© Google LLC/)) {
      expect(google).toHaveTextContent('Apache License 2.0')
    }
    expect(screen.getByText('EmbeddingGemma 2')).toBeInTheDocument()
    expect(screen.queryByText('Modelle von Drittanbietern')).not.toBeInTheDocument()
  })

  it('renders a license text only after its entry is opened', () => {
    render(<AboutPage />)
    expect(screen.queryByText(/The ggml authors/)).not.toBeInTheDocument()

    const details = screen.getByText('llama.cpp').closest('details')!
    details.open = true
    fireEvent(details, new Event('toggle'))

    expect(screen.getByText(/The ggml authors/)).toBeInTheDocument()
  })

  it('says what copying puts on the clipboard in which view, and that it leaves the app (#203)', () => {
    render(<AboutPage />)
    expect(screen.getByText(/Kopiert wird immer die gewählte Ansicht/)).toHaveTextContent(
      'pseudonymisierte Angaben als Platzhalter wie [PERSON 1]'
    )
    expect(screen.getByText(/Kopiert wird immer die gewählte Ansicht/)).toHaveTextContent(
      'was die Pseudonymisierung nicht erfasst hat'
    )
    expect(
      screen.getByText(/verlässt Therascript über die Zwischenablage Ihres Macs/)
    ).toBeInTheDocument()
  })

  it('sagt, dass Patientendossiers lokal bleiben, bis man sie löscht oder TheraScript entfernt (#204 AK 19)', () => {
    render(<AboutPage />)
    expect(
      screen.getByText(/Patientendossiers mit Stammdaten, Diagnosen, Medikation und Notiz/)
    ).toHaveTextContent(
      'bleiben lokal gespeichert, bis Sie sie löschen oder TheraScript vollständig entfernen'
    )
  })

  it('nennt die Patientendossiers vor dem vollständigen Entfernen (#204 AK 18)', () => {
    render(<AboutPage />)
    fireEvent.click(screen.getByRole('button', { name: 'TheraScript vollständig entfernen' }))
    expect(
      screen.getByText('Alle Patientendossiers (Stammdaten, Diagnosen, Medikation, Notizen)')
    ).toBeInTheDocument()
  })
})
