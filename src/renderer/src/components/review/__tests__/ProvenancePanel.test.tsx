import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProvenancePanel } from '../ProvenancePanel'
import type { ProcessedModelsSnapshot } from '../../../../../shared/types'

const SHA = (c: string): string => c.repeat(64)

const fullSnapshot: ProcessedModelsSnapshot = {
  capturedAt: '2026-04-15T14:32:00Z',
  asr: {
    id: 'whisper-large-v3-turbo',
    label: 'Whisper Large V3 Turbo',
    version: '2026-04-01',
    sha256: SHA('a'),
    sizeBytes: 1_700_000_000
  },
  diarization: {
    id: 'pyannote-suite',
    label: 'pyannote 3.1',
    version: '2026-03-12',
    sha256: SHA('b'),
    sizeBytes: 200_000_000
  },
  ner: {
    id: 'flair-ner-german-large',
    label: 'flair NER German Large',
    version: '2026-02-08',
    sha256: SHA('c'),
    sizeBytes: 1_100_000_000
  },
  summarization: null
}

describe('ProvenancePanel', () => {
  it('renders the legacy hint when data is null', async () => {
    const user = userEvent.setup()
    render(<ProvenancePanel data={null} reviewAt={null} />)

    await user.click(screen.getByText('Verarbeitungs-Information'))
    expect(
      screen.getByText(/vor Einführung der detaillierten Modell-Protokollierung/i)
    ).toBeInTheDocument()
  })

  it('renders model rows with label, version and size on open', async () => {
    const user = userEvent.setup()
    render(<ProvenancePanel data={fullSnapshot} reviewAt="2026-04-15T14:32:00Z" />)

    await user.click(screen.getByText('Verarbeitungs-Information'))

    // Group labels appear twice (main row + Technische Details key) — both
    // are intentional. We just assert presence and the model-specific values.
    expect(screen.getByText('Whisper Large V3 Turbo')).toBeInTheDocument()
    expect(screen.getByText(/Version 2026-04-01/)).toBeInTheDocument()
    expect(screen.getAllByText('Spracherkennung').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Sprechererkennung').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Pseudonymisierung').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Zusammenfassung').length).toBeGreaterThan(0)
  })

  it('shows "nicht erstellt" for skipped optional groups (e.g. summarization)', async () => {
    const user = userEvent.setup()
    render(<ProvenancePanel data={fullSnapshot} reviewAt={null} />)

    await user.click(screen.getByText('Verarbeitungs-Information'))
    // summarization is null in the snapshot
    expect(screen.getByText('nicht erstellt')).toBeInTheDocument()
  })

  it('exposes id + sha256 inside the "Technische Details" sub-disclosure', async () => {
    const user = userEvent.setup()
    render(<ProvenancePanel data={fullSnapshot} reviewAt={null} />)

    await user.click(screen.getByText('Verarbeitungs-Information'))
    await user.click(screen.getByText(/Technische Details/i))

    expect(screen.getByText('id: whisper-large-v3-turbo')).toBeInTheDocument()
    expect(screen.getByText(`sha256: ${SHA('a')}`)).toBeInTheDocument()
    expect(screen.getByText(`sha256: ${SHA('b')}`)).toBeInTheDocument()
  })

  it('omits the "Verarbeitet am" row when reviewAt is null', async () => {
    const user = userEvent.setup()
    render(<ProvenancePanel data={fullSnapshot} reviewAt={null} />)
    await user.click(screen.getByText('Verarbeitungs-Information'))
    expect(screen.queryByText('Verarbeitet am')).not.toBeInTheDocument()
  })
})
