import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SessionCard } from '../SessionCard'
import type { Session } from '../../../../shared/types'
import { useTaskProgress } from '../../hooks/useTaskProgress'

vi.mock('../../hooks/useTaskProgress', () => ({
  useTaskProgress: vi.fn()
}))

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    title: 'Test',
    type: 'audio',
    status: 'review',
    audioPath: null,
    transcriptPath: null,
    anonymizedPath: null,
    diarizationPath: null,
    alignedTranscriptPath: null,
    pdfPath: null,
    extractedPath: null,
    entityMap: null,
    errorMessage: null,
    createdAt: '2026-04-29T12:00:00Z',
    updatedAt: '2026-04-29T12:00:00Z',
    reviewAt: null,
    wordCount: 4287,
    summary: null,
    summaryModelId: null,
    summarizedAt: null,
    plannedSteps: null,
    retryCount: 0,
    ...overrides
  }
}

const emptyHookResult = {
  tasks: [],
  loading: false,
  current: null,
  queuePosition: null
}

describe('SessionCard — review state', () => {
  beforeEach(() => {
    vi.mocked(useTaskProgress).mockReturnValue(emptyHookResult)
  })

  it('renders word count when wordCount > 0', () => {
    render(<SessionCard session={makeSession({ wordCount: 4287 })} onDelete={vi.fn()} />)
    // de-CH locale formats 4287 with a thin-space or apostrophe-like grouping.
    // Match flexibly on the prefix + suffix; the grouping char is locale-impl-specific.
    expect(screen.getByText(/4.{0,3}287 Wörter/)).toBeInTheDocument()
  })
})

describe('SessionCard — queued state', () => {
  it('renders waiting label with position from useTaskProgress', () => {
    vi.mocked(useTaskProgress).mockReturnValue({ ...emptyHookResult, queuePosition: 2 })
    render(<SessionCard session={makeSession({ status: 'queued' })} onDelete={vi.fn()} />)
    expect(screen.getByText('Wartet — Position 2')).toBeInTheDocument()
  })

  it('falls back to plain "Wartet" before queue:positions arrives', () => {
    vi.mocked(useTaskProgress).mockReturnValue({ ...emptyHookResult, queuePosition: null })
    render(<SessionCard session={makeSession({ status: 'queued' })} onDelete={vi.fn()} />)
    expect(screen.getByText('Wartet')).toBeInTheDocument()
  })
})

describe('SessionCard — processing state (audio)', () => {
  it('renders Schritt 3/5 · Gespräch transkribieren during transcription', () => {
    vi.mocked(useTaskProgress).mockReturnValue({
      tasks: [],
      loading: false,
      current: {
        taskType: 'transcription',
        progress: 0.64,
        stepIndex: 3,
        totalSteps: 5,
        etaSecondsTotal: 180,
        plannedDurationSec: 300,
        isTransitioning: false
      },
      queuePosition: null
    })
    render(<SessionCard session={makeSession({ status: 'processing' })} onDelete={vi.fn()} />)
    expect(screen.getByText('Schritt 3/5 · Gespräch transkribieren')).toBeInTheDocument()
  })

  it('renders preparingNext during transitioning state', () => {
    vi.mocked(useTaskProgress).mockReturnValue({
      tasks: [],
      loading: false,
      current: {
        taskType: 'transcription',
        progress: 1,
        stepIndex: 3,
        totalSteps: 5,
        etaSecondsTotal: null,
        plannedDurationSec: null,
        isTransitioning: true
      },
      queuePosition: null
    })
    render(<SessionCard session={makeSession({ status: 'processing' })} onDelete={vi.fn()} />)
    expect(screen.getByText('Nächster Schritt wird vorbereitet…')).toBeInTheDocument()
  })

  it('renders ETA text when etaSecondsTotal is available', () => {
    vi.mocked(useTaskProgress).mockReturnValue({
      tasks: [],
      loading: false,
      current: {
        taskType: 'transcription',
        progress: 0.5,
        stepIndex: 3,
        totalSteps: 5,
        etaSecondsTotal: 180,
        plannedDurationSec: 300,
        isTransitioning: false
      },
      queuePosition: null
    })
    render(<SessionCard session={makeSession({ status: 'processing' })} onDelete={vi.fn()} />)
    expect(screen.getByText('noch ca. 3 Min.')).toBeInTheDocument()
  })

  it('hides ETA text when etaSecondsTotal is null (uncalibrated)', () => {
    vi.mocked(useTaskProgress).mockReturnValue({
      tasks: [],
      loading: false,
      current: {
        taskType: 'transcription',
        progress: 0.5,
        stepIndex: 3,
        totalSteps: 5,
        etaSecondsTotal: null,
        plannedDurationSec: null,
        isTransitioning: false
      },
      queuePosition: null
    })
    const { container } = render(
      <SessionCard session={makeSession({ status: 'processing' })} onDelete={vi.fn()} />
    )
    expect(container.querySelector('[title*="Geschätzt"]')).toBeNull()
  })

  it('shows step-only label when totalSteps is 0 (plannedSteps not yet set)', () => {
    vi.mocked(useTaskProgress).mockReturnValue({
      tasks: [],
      loading: false,
      current: {
        taskType: 'transcription',
        progress: 0.5,
        stepIndex: 0,
        totalSteps: 0,
        etaSecondsTotal: null,
        plannedDurationSec: null,
        isTransitioning: false
      },
      queuePosition: null
    })
    render(<SessionCard session={makeSession({ status: 'processing' })} onDelete={vi.fn()} />)
    expect(screen.getByText('Gespräch transkribieren')).toBeInTheDocument()
    expect(screen.queryByText(/Schritt 0/)).toBeNull()
  })

  it('falls back to status label when current is null mid-processing', () => {
    vi.mocked(useTaskProgress).mockReturnValue(emptyHookResult)
    render(<SessionCard session={makeSession({ status: 'processing' })} onDelete={vi.fn()} />)
    expect(screen.getByText('Verarbeitung')).toBeInTheDocument()
  })
})

describe('SessionCard — processing state (PDF)', () => {
  it('renders Text auslesen for extraction step', () => {
    vi.mocked(useTaskProgress).mockReturnValue({
      tasks: [],
      loading: false,
      current: {
        taskType: 'extraction',
        progress: 0.5,
        stepIndex: 1,
        totalSteps: 2,
        etaSecondsTotal: null,
        plannedDurationSec: null,
        isTransitioning: false
      },
      queuePosition: null
    })
    render(
      <SessionCard
        session={makeSession({ type: 'pdf', status: 'processing' })}
        onDelete={vi.fn()}
      />
    )
    expect(screen.getByText('Schritt 1/2 · Text auslesen')).toBeInTheDocument()
  })

  it('renders Schrift erkennen for OCR step', () => {
    vi.mocked(useTaskProgress).mockReturnValue({
      tasks: [],
      loading: false,
      current: {
        taskType: 'ocr',
        progress: 0.3,
        stepIndex: 2,
        totalSteps: 3,
        etaSecondsTotal: null,
        plannedDurationSec: null,
        isTransitioning: false
      },
      queuePosition: null
    })
    render(
      <SessionCard
        session={makeSession({ type: 'pdf', status: 'processing' })}
        onDelete={vi.fn()}
      />
    )
    expect(screen.getByText('Schritt 2/3 · Schrift erkennen')).toBeInTheDocument()
  })
})

describe('SessionCard — error state', () => {
  beforeEach(() => {
    vi.mocked(useTaskProgress).mockReturnValue(emptyHookResult)
  })

  it('renders Erneut versuchen button when onRetry is provided', () => {
    render(
      <SessionCard
        session={makeSession({ status: 'error', errorMessage: 'foo' })}
        onDelete={vi.fn()}
        onRetry={vi.fn()}
      />
    )
    expect(screen.getByText('Erneut versuchen')).toBeInTheDocument()
  })
})
