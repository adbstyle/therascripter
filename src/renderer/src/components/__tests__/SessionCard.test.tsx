import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SessionCard } from '../SessionCard'
import { PIPELINE_UI_STRINGS } from '../../../../shared/constants/pipelineWording'
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
    anonymizationCount: null,
    summary: null,
    summaryModelId: null,
    summarizedAt: null,
    plannedSteps: null,
    retryCount: 0,
    pdfHasScannedPages: null,
    processedWithModels: null,
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

  it('appends singular Pseudonymisierung when anonymizationCount === 1', () => {
    render(
      <SessionCard
        session={makeSession({ wordCount: 100, anonymizationCount: 1 })}
        onDelete={vi.fn()}
      />
    )
    expect(screen.getByText(/100 Wörter · 1 Pseudonymisierung$/)).toBeInTheDocument()
  })

  it('appends plural Pseudonymisierungen when anonymizationCount >= 2', () => {
    render(
      <SessionCard
        session={makeSession({ wordCount: 289, anonymizationCount: 22 })}
        onDelete={vi.fn()}
      />
    )
    expect(screen.getByText(/289 Wörter · 22 Pseudonymisierungen$/)).toBeInTheDocument()
  })

  it('omits Pseudonymisierungen when anonymizationCount === 0', () => {
    render(
      <SessionCard
        session={makeSession({ wordCount: 50, anonymizationCount: 0 })}
        onDelete={vi.fn()}
      />
    )
    expect(screen.queryByText(/Pseudonymisierung/)).toBeNull()
  })

  it('omits Pseudonymisierungen when anonymizationCount is null (legacy, pre-backfill)', () => {
    render(
      <SessionCard
        session={makeSession({ wordCount: 50, anonymizationCount: null })}
        onDelete={vi.fn()}
      />
    )
    expect(screen.queryByText(/Pseudonymisierung/)).toBeNull()
  })

  it('does not show Pseudonymisierungen on non-review status', () => {
    render(
      <SessionCard
        session={makeSession({ status: 'queued', wordCount: 100, anonymizationCount: 5 })}
        onDelete={vi.fn()}
      />
    )
    expect(screen.queryByText(/Pseudonymisierung/)).toBeNull()
  })

  it('does not show Pseudonymisierungen on empty-speech (wordCount === 0) sessions', () => {
    render(
      <SessionCard
        session={makeSession({ wordCount: 0, anonymizationCount: 0 })}
        onDelete={vi.fn()}
      />
    )
    expect(screen.queryByText(/Pseudonymisierung/)).toBeNull()
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
        isTransitioning: true
      },
      queuePosition: null
    })
    render(<SessionCard session={makeSession({ status: 'processing' })} onDelete={vi.fn()} />)
    expect(screen.getByText('Nächster Schritt wird vorbereitet…')).toBeInTheDocument()
  })

  it('renders the step-bar with step-name aria-label when processing', () => {
    vi.mocked(useTaskProgress).mockReturnValue({
      tasks: [],
      loading: false,
      current: {
        taskType: 'transcription',
        progress: 0.5,
        stepIndex: 3,
        totalSteps: 5,
        isTransitioning: false
      },
      queuePosition: null
    })
    const { container } = render(
      <SessionCard session={makeSession({ status: 'processing' })} onDelete={vi.fn()} />
    )
    expect(container.querySelector('[aria-label*="Gespräch transkribieren"]')).toBeTruthy()
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

describe('SessionCard — empty-speech variant (review + wordCount === 0)', () => {
  beforeEach(() => {
    vi.mocked(useTaskProgress).mockReturnValue(emptyHookResult)
  })

  it('renders Keine Sprache erkannt headline when wordCount === 0', () => {
    render(<SessionCard session={makeSession({ wordCount: 0 })} onDelete={vi.fn()} />)
    expect(screen.getByText('Keine Sprache erkannt')).toBeInTheDocument()
  })

  it('renders empty-speech body explanation', () => {
    render(<SessionCard session={makeSession({ wordCount: 0 })} onDelete={vi.fn()} />)
    expect(screen.getByText(/ohne dass Sprache erkannt wurde/)).toBeInTheDocument()
  })

  it('does not render empty-speech variant when wordCount > 0', () => {
    render(<SessionCard session={makeSession({ wordCount: 5 })} onDelete={vi.fn()} />)
    expect(screen.queryByText('Keine Sprache erkannt')).toBeNull()
  })

  it('does not render empty-speech variant for non-review status', () => {
    render(
      <SessionCard
        session={makeSession({ status: 'processing', wordCount: 0 })}
        onDelete={vi.fn()}
      />
    )
    expect(screen.queryByText('Keine Sprache erkannt')).toBeNull()
  })
})

describe('SessionCard — error state with 3-stage retry-limit UX', () => {
  beforeEach(() => {
    vi.mocked(useTaskProgress).mockReturnValue(emptyHookResult)
  })

  it('shows plain Retry button on first failure (retryCount === 0)', () => {
    render(
      <SessionCard
        session={makeSession({ status: 'error', errorMessage: 'foo', retryCount: 0 })}
        onDelete={vi.fn()}
        onRetry={vi.fn()}
      />
    )
    expect(screen.getByText('Erneut versuchen')).toBeInTheDocument()
    expect(screen.queryByText(/Erster Versuch/)).toBeNull()
    expect(screen.queryByText(/Mehrfach-Fehler/)).toBeNull()
  })

  it('shows Erster Versuch hint on retryCount === 1', () => {
    render(
      <SessionCard
        session={makeSession({ status: 'error', errorMessage: 'foo', retryCount: 1 })}
        onDelete={vi.fn()}
        onRetry={vi.fn()}
      />
    )
    expect(screen.getByText('Erster Versuch ist fehlgeschlagen.')).toBeInTheDocument()
    expect(screen.getByText('Erneut versuchen')).toBeInTheDocument()
  })

  it('shows escalated Mehrfach-Fehler hint on retryCount === 2', () => {
    render(
      <SessionCard
        session={makeSession({ status: 'error', errorMessage: 'foo', retryCount: 2 })}
        onDelete={vi.fn()}
        onRetry={vi.fn()}
      />
    )
    expect(screen.getByText(/Mehrfach-Fehler/)).toBeInTheDocument()
    expect(screen.getByText('Erneut versuchen')).toBeInTheDocument()
  })

  it('hides retry button and shows Support hint on retryCount >= 3', () => {
    render(
      <SessionCard
        session={makeSession({ status: 'error', errorMessage: 'foo', retryCount: 3 })}
        onDelete={vi.fn()}
        onRetry={vi.fn()}
      />
    )
    expect(screen.queryByText('Erneut versuchen')).toBeNull()
    expect(screen.getByText(/Wenden Sie sich an den Support/)).toBeInTheDocument()
  })
})

// Issue #140: SessionDashboard reicht stabile Handler durch (memo) — die
// Karte muss deshalb selbst Session bzw. ID mitgeben.
describe('SessionCard — Callbacks', () => {
  beforeEach(() => {
    vi.mocked(useTaskProgress).mockReturnValue(emptyHookResult)
  })

  it('übergibt die Session an onDelete und die ID an onClick', async () => {
    const user = userEvent.setup()
    const session = makeSession({ title: 'Erstgespräch' })
    const onDelete = vi.fn()
    const onClick = vi.fn()
    render(<SessionCard session={session} onDelete={onDelete} onClick={onClick} />)

    await user.click(screen.getByLabelText('Transkription löschen'))
    expect(onDelete).toHaveBeenCalledWith(session)

    await user.click(screen.getByLabelText('Erstgespräch öffnen'))
    expect(onClick).toHaveBeenCalledWith('s1')
  })

  it('übergibt die ID an onRetry', async () => {
    const user = userEvent.setup()
    const onRetry = vi.fn()
    render(
      <SessionCard
        session={makeSession({ status: 'error', errorMessage: 'Fehler' })}
        onDelete={vi.fn()}
        onRetry={onRetry}
      />
    )

    await user.click(screen.getByRole('button', { name: PIPELINE_UI_STRINGS.retryButton }))
    expect(onRetry).toHaveBeenCalledWith('s1')
  })
})

describe('SessionCard — memo und Zeitstempel', () => {
  beforeEach(() => {
    vi.mocked(useTaskProgress).mockReturnValue(emptyHookResult)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // Issue #140: Rendert das Dashboard neu (Refresh-Trigger, Import, Aufnahme-
  // Start), dürfen Karten mit unveränderten Props nicht mitrendern.
  it('rendert bei identischen Props nicht neu', () => {
    const session = makeSession()
    const onDelete = vi.fn()
    const { rerender } = render(<SessionCard session={session} onDelete={onDelete} />)
    const callsAfterMount = vi.mocked(useTaskProgress).mock.calls.length

    rerender(<SessionCard session={session} onDelete={onDelete} />)
    expect(vi.mocked(useTaskProgress).mock.calls.length).toBe(callsAfterMount)
  })

  it('wechselt bei neuem Tag auf "Gestern", obwohl die Session gleich bleibt', () => {
    const session = makeSession({ createdAt: new Date(2026, 3, 28, 14, 2).toISOString() })
    const onDelete = vi.fn()
    const { rerender } = render(
      <SessionCard session={session} onDelete={onDelete} today={new Date(2026, 3, 28).getTime()} />
    )
    expect(screen.getByText('14:02')).toBeInTheDocument()

    rerender(
      <SessionCard session={session} onDelete={onDelete} today={new Date(2026, 3, 29).getTime()} />
    )
    expect(screen.getByText('Gestern, 14:02')).toBeInTheDocument()
  })

  it.each([
    ['heute', new Date(2026, 3, 29, 14, 2), '14:02'],
    ['gestern', new Date(2026, 3, 28, 14, 2), 'Gestern, 14:02'],
    ['im laufenden Jahr', new Date(2026, 3, 27, 14, 2), '27.04., 14:02'],
    ['in einem früheren Jahr', new Date(2025, 3, 27, 14, 2), '27.04.25']
  ])('formatiert den Zeitstempel %s', (_label, createdAt, expected) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 3, 29, 18, 0))
    render(
      <SessionCard
        session={makeSession({ createdAt: createdAt.toISOString() })}
        onDelete={vi.fn()}
      />
    )
    expect(screen.getByText(expected)).toBeInTheDocument()
  })
})
