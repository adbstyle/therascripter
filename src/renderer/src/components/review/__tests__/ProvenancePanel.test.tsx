import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { ProvenancePanel } from '../ProvenancePanel'
import type { AudioStats, ProcessedModelsSnapshot } from '../../../../../shared/types'

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
  it('renders the legacy hint when data is null', () => {
    render(<ProvenancePanel data={null} reviewAt={null} audioStats={null} />)
    expect(
      screen.getByText(/vor Einführung der detaillierten Modell-Protokollierung/i)
    ).toBeInTheDocument()
  })

  it('renders model rows with label, version and size', () => {
    render(<ProvenancePanel data={fullSnapshot} reviewAt="2026-04-15T14:32:00Z" audioStats={null} />)

    expect(screen.getByText('Whisper Large V3 Turbo')).toBeInTheDocument()
    expect(screen.getByText(/Version 2026-04-01/)).toBeInTheDocument()
    expect(screen.getAllByText('Spracherkennung').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Sprechererkennung').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Pseudonymisierung').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Zusammenfassung').length).toBeGreaterThan(0)
  })

  it('shows "nicht erstellt" for skipped optional groups (e.g. summarization)', () => {
    render(<ProvenancePanel data={fullSnapshot} reviewAt={null} audioStats={null} />)
    expect(screen.getByText('nicht erstellt')).toBeInTheDocument()
  })

  it('shows id + sha256 inline under each model row', () => {
    render(<ProvenancePanel data={fullSnapshot} reviewAt={null} audioStats={null} />)

    expect(screen.getByText('id: whisper-large-v3-turbo')).toBeInTheDocument()
    expect(screen.getByText(`sha256: ${SHA('a')}`)).toBeInTheDocument()
    expect(screen.getByText(`sha256: ${SHA('b')}`)).toBeInTheDocument()
  })

  it('omits the "Verarbeitet am" row when reviewAt is null', () => {
    render(<ProvenancePanel data={fullSnapshot} reviewAt={null} audioStats={null} />)
    expect(screen.queryByText('Verarbeitet am')).not.toBeInTheDocument()
  })
})

describe('ProvenancePanel — Audio section (Issue #99)', () => {
  const fullStats: AudioStats = {
    originalDurationSec: 329,
    stitchedDurationSec: 252,
    speakerCount: 2,
    diarizationModel: 'pyannote/speaker-diarization-community-1'
  }

  function row(label: string): HTMLElement {
    // Each row is a <div> containing the label as a sibling of the value
    const labelEl = screen.getByText(label)
    return labelEl.parentElement as HTMLElement
  }

  it('renders Original-Dauer, Sprache, Stille, Sprecher and Sprecher-Pipeline (AC1-AC6)', () => {
    render(<ProvenancePanel data={null} reviewAt={null} audioStats={fullStats} />)

    expect(within(row('Original-Dauer')).getByText('5m 29s')).toBeInTheDocument()
    expect(within(row('Sprache')).getByText('4m 12s')).toBeInTheDocument()
    // 77 / 329 = 23.4% (one decimal, AC postcondition)
    expect(within(row('Stille')).getByText('1m 17s · 23.4 %')).toBeInTheDocument()
    expect(within(row('Sprecher')).getByText('2')).toBeInTheDocument()
    expect(
      within(row('Sprecher-Pipeline')).getByText(
        'pyannote/speaker-diarization-community-1'
      )
    ).toBeInTheDocument()
  })

  it('renders the "einzelner Sprecher erkannt" hint when speakerCount === 1 (AC5)', () => {
    render(
      <ProvenancePanel
        data={null}
        reviewAt={null}
        audioStats={{ ...fullStats, speakerCount: 1 }}
      />
    )
    expect(screen.getByText('einzelner Sprecher erkannt')).toBeInTheDocument()
  })

  it('shows "nicht verfügbar" for Sprache and Stille on legacy sessions without stitchMap (AC8)', () => {
    render(
      <ProvenancePanel
        data={null}
        reviewAt={null}
        audioStats={{
          originalDurationSec: 329,
          stitchedDurationSec: null,
          speakerCount: 2,
          diarizationModel: 'pyannote/speaker-diarization-3.1'
        }}
      />
    )
    expect(within(row('Original-Dauer')).getByText('5m 29s')).toBeInTheDocument()
    expect(within(row('Sprache')).getByText('nicht verfügbar')).toBeInTheDocument()
    expect(within(row('Stille')).getByText('nicht verfügbar')).toBeInTheDocument()
    expect(within(row('Sprecher')).getByText('2')).toBeInTheDocument()
  })

  it('shows 0s speech and 100 % silence for empty-speech sessions (AC9)', () => {
    render(
      <ProvenancePanel
        data={null}
        reviewAt={null}
        audioStats={{
          originalDurationSec: 60,
          stitchedDurationSec: 0,
          speakerCount: 0,
          diarizationModel: 'pyannote/speaker-diarization-3.1'
        }}
      />
    )
    expect(within(row('Sprache')).getByText('0s')).toBeInTheDocument()
    expect(within(row('Stille')).getByText('1m 0s · 100.0 %')).toBeInTheDocument()
  })

  it('hides the audio section entirely when audioStats is null (AC7 — PDF sessions)', () => {
    const provenance: ProcessedModelsSnapshot = {
      capturedAt: '2026-04-15T14:32:00Z',
      asr: null,
      diarization: null,
      ner: null,
      summarization: null
    }
    render(<ProvenancePanel data={provenance} reviewAt={null} audioStats={null} />)
    expect(screen.queryByText('Original-Dauer')).not.toBeInTheDocument()
    expect(screen.queryByText('Sprache')).not.toBeInTheDocument()
    expect(screen.queryByText('Sprecher')).not.toBeInTheDocument()
  })

  it('renders Audio above the model sections (AC1)', () => {
    const provenance: ProcessedModelsSnapshot = {
      capturedAt: '2026-04-15T14:32:00Z',
      asr: {
        id: 'whisper-large-v3-turbo',
        label: 'Whisper Large V3 Turbo',
        version: '2026-04-01',
        sha256: 'a'.repeat(64),
        sizeBytes: 1_700_000_000
      },
      diarization: null,
      ner: null,
      summarization: null
    }
    render(<ProvenancePanel data={provenance} reviewAt={null} audioStats={fullStats} />)

    const audioLabel = screen.getByText('Original-Dauer')
    const asrLabel = screen.getByText('Spracherkennung')
    expect(
      audioLabel.compareDocumentPosition(asrLabel) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })
})
