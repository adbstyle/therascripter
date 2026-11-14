import type { ReactNode } from 'react'
import { Info } from 'lucide-react'
import type { Session, SessionStatus } from '../../../../shared/types'
import { STEP_LABELS_DE, PIPELINE_UI_STRINGS } from '../../../../shared/constants/pipelineWording'
import { useTaskProgress } from '../../hooks/useTaskProgress'
import { isToolBlockedMessage } from '../../../../shared/tool-blocked'

const STATUS_CONFIG: Record<SessionStatus, { label: string; color: string }> = {
  recording: { label: 'Aufnahme läuft', color: 'text-recording' },
  queued: { label: 'Wartet', color: 'text-text-secondary' },
  processing: { label: 'Verarbeitung', color: 'text-primary' },
  review: { label: 'Review', color: 'text-success' },
  error: { label: 'Fehler', color: 'text-error-text' }
}

function isInPipeline(status: SessionStatus): boolean {
  return status === 'processing' || status === 'queued'
}

interface SessionStatusBlockProps {
  session: Session
  onRetry?: (sessionId: string) => void
  retryDisabled?: boolean
  /** Rechts in der Statuszeile, z. B. das Symbol der Art. */
  trailing?: ReactNode
}

/**
 * Zustand einer Sitzung auf ihrer Karte — gemeinsam für Sitzungsliste und
 * Verlauf eines Patientendossiers (#205 AK 12): Statuszeile (Wörter und
 * Pseudonymisierungen, Warteposition, Verarbeitungsschritt, Fehler), leere
 * Aufnahme, Fehlermeldung mit «Erneut versuchen» und Fortschrittsbalken.
 *
 * Die Karten legen eine unsichtbare Klickfläche über die ganze Karte; der
 * Block ist deshalb `pointer-events-none`, nur «Erneut versuchen» nimmt
 * Klicks an.
 */
export function SessionStatusBlock({
  session,
  onRetry,
  retryDisabled,
  trailing
}: SessionStatusBlockProps): React.JSX.Element {
  // Subscribe to progress events for both queued (to receive queue:positions)
  // and processing (to receive task:started / task:progress).
  const subscribed = isInPipeline(session.status)
  const { current, queuePosition } = useTaskProgress(
    subscribed ? session.id : null,
    session.plannedSteps
  )

  const statusConfig = STATUS_CONFIG[session.status]
  const isProcessing = session.status === 'processing'
  const isQueued = session.status === 'queued'
  const isReview = session.status === 'review'

  // Phase L: Empty-speech is signalled via wordCount === 0 on a review session.
  // Visual treatment: Info icon + headline in the status row, body text below.
  // #168 — Verarbeitung an einem von macOS blockierten Werkzeug gescheitert
  const toolBlocked = isToolBlockedMessage(session.errorMessage)
  const isEmptySpeech = isReview && session.wordCount === 0

  let statusContent: ReactNode
  if (isReview) {
    if (isEmptySpeech) {
      statusContent = (
        <>
          <Info className="h-3.5 w-3.5 text-text-secondary" strokeWidth={1.75} aria-hidden="true" />
          <span className="text-xs font-medium text-text-secondary">
            {PIPELINE_UI_STRINGS.emptySpeechHeadline}
          </span>
        </>
      )
    } else {
      // Append pseudonymization count inline after the word count when > 0.
      // Hidden when 0 (no audit signal). Singular form for 1, plural for 2+.
      const anonCount = session.anonymizationCount ?? 0
      statusContent =
        session.wordCount != null ? (
          <span className="text-xs text-text-tertiary">
            {session.wordCount.toLocaleString('de-CH')} Wörter
            {anonCount > 0 && (
              <>
                {' · '}
                {anonCount.toLocaleString('de-CH')}{' '}
                {anonCount === 1 ? 'Pseudonymisierung' : 'Pseudonymisierungen'}
              </>
            )}
          </span>
        ) : null
    }
  } else if (isQueued) {
    statusContent = (
      <span className="text-xs font-medium text-text-secondary" aria-live="polite">
        {queuePosition != null ? PIPELINE_UI_STRINGS.waiting(queuePosition) : statusConfig.label}
      </span>
    )
  } else if (isProcessing && current) {
    const stepLabel = STEP_LABELS_DE[current.taskType]
    const headline = current.isTransitioning
      ? PIPELINE_UI_STRINGS.preparingNext
      : current.totalSteps > 0
        ? PIPELINE_UI_STRINGS.step(current.stepIndex, current.totalSteps, stepLabel)
        : stepLabel
    statusContent = <span className="text-xs font-medium text-primary">{headline}</span>
  } else {
    statusContent = (
      <span className={`text-xs font-medium ${statusConfig.color}`}>{statusConfig.label}</span>
    )
  }

  // ---- Progress-Zeile ---------------------------------------------------
  // ETA + Gesamt-Bar wurden zurückgebaut: baked-in Schätzwerte sind
  // hardware-abhängig und führen zu irreführenden Anzeigen, eine Calibration
  // mit ≥3 echten Sessions ist für viele User in der Praxis nie erreicht.
  // Sichtbares Feedback ist der Schritt-Counter (Status-Zeile) + die
  // schritt-eigene Bar.
  const showTransitionBar = isProcessing && current != null && current.isTransitioning
  const showStepBar = isProcessing && current != null && !current.isTransitioning
  const stepProgressPct = current ? Math.round(current.progress * 100) : 0
  const stepLabel = current ? STEP_LABELS_DE[current.taskType] : ''

  return (
    <>
      <div className="pointer-events-none relative z-[1] mt-1.5 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">{statusContent}</div>
        {trailing}
      </div>

      {isEmptySpeech && (
        <p
          className="pointer-events-none relative z-[1] mt-1 line-clamp-2 text-xs text-text-tertiary"
          role="alert"
        >
          {PIPELINE_UI_STRINGS.emptySpeechBody}
        </p>
      )}

      {session.status === 'error' && session.errorMessage && (
        <p className="pointer-events-none relative z-[1] mt-1 line-clamp-3 text-xs text-text-tertiary">
          {session.errorMessage}
        </p>
      )}
      {/* Phase M: 3-stage retry-limit UX driven by Session.retryCount. Eine
          Blockade durch macOS (#168) zählt nicht: die Meldung oben sagt, was zu
          tun ist, und «Erneut versuchen» bleibt, bis sie behoben ist. */}
      {session.status === 'error' && !toolBlocked && session.retryCount === 1 && (
        <p className="pointer-events-none relative z-[1] mt-1 text-xs text-text-tertiary">
          {PIPELINE_UI_STRINGS.retryAfterFirstFailure}
        </p>
      )}
      {session.status === 'error' && !toolBlocked && session.retryCount === 2 && (
        <p className="pointer-events-none relative z-[1] mt-1 text-xs text-text-tertiary">
          {PIPELINE_UI_STRINGS.retryAfterSecondFailure}
        </p>
      )}
      {session.status === 'error' && (toolBlocked || session.retryCount < 3) && onRetry && (
        <button
          className="pointer-events-auto relative z-10 mt-1.5 text-xs font-medium text-primary hover:text-primary-hover disabled:cursor-not-allowed disabled:text-text-secondary"
          onClick={() => onRetry(session.id)}
          disabled={retryDisabled}
          title={retryDisabled ? 'Eine andere Transkription wird gerade verarbeitet' : undefined}
        >
          {PIPELINE_UI_STRINGS.retryButton}
        </button>
      )}
      {session.status === 'error' && !toolBlocked && session.retryCount >= 3 && (
        <p
          className="pointer-events-none relative z-[1] mt-1.5 text-xs text-text-tertiary"
          role="alert"
        >
          {PIPELINE_UI_STRINGS.retryExhausted}
        </p>
      )}

      {showStepBar && (
        <div className="pointer-events-none relative z-[1] mt-2">
          <div
            className="h-1 w-full overflow-hidden rounded-full bg-surface-2"
            role="progressbar"
            aria-valuenow={stepProgressPct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={
              current && current.totalSteps > 0
                ? `${PIPELINE_UI_STRINGS.step(current.stepIndex, current.totalSteps, stepLabel)}, ${stepProgressPct} Prozent`
                : `${stepLabel}, ${stepProgressPct} Prozent`
            }
          >
            <div
              className="h-full rounded-full bg-primary transition-all duration-300"
              style={{ width: `${stepProgressPct}%` }}
            />
          </div>
        </div>
      )}

      {showTransitionBar && (
        <div className="pointer-events-none relative z-[1] mt-2">
          <div
            className="h-1 w-full overflow-hidden rounded-full bg-surface-2"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={PIPELINE_UI_STRINGS.preparingNext}
          >
            <div className="h-full w-1/4 animate-pulse rounded-full bg-surface-3" />
          </div>
        </div>
      )}
    </>
  )
}
