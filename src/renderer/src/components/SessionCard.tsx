import { FileText, Info, Mic, Trash2 } from 'lucide-react'
import type { Session, SessionStatus } from '../../../shared/types'
import {
  STEP_LABELS_DE,
  PIPELINE_UI_STRINGS,
  formatEta
} from '../../../shared/constants/pipelineWording'
import { useTaskProgress } from '../hooks/useTaskProgress'

interface SessionCardProps {
  session: Session
  onDelete: () => void
  onClick?: () => void
  onRetry?: () => void
  retryDisabled?: boolean
  'data-session-id'?: string
}

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

function formatCardTimestamp(iso: string): string {
  const date = new Date(iso)
  const now = new Date()
  const time = date.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const dayDiff = Math.round((startOfToday.getTime() - startOfDate.getTime()) / 86_400_000)

  if (dayDiff === 0) return time
  if (dayDiff === 1) return `Gestern, ${time}`

  if (date.getFullYear() === now.getFullYear()) {
    const dm = date.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit' })
    return `${dm}, ${time}`
  }

  return date.toLocaleDateString('de-CH', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit'
  })
}

export function SessionCard({
  session,
  onDelete,
  onClick,
  onRetry,
  retryDisabled,
  'data-session-id': dataSessionId
}: SessionCardProps): React.JSX.Element {
  // Subscribe to progress events for both queued (to receive queue:positions)
  // and processing (to receive task:started / task:progress).
  const subscribed = isInPipeline(session.status)
  const { current, queuePosition } = useTaskProgress(subscribed ? session.id : null)

  const statusConfig = STATUS_CONFIG[session.status]
  const TypeIcon = session.type === 'audio' ? Mic : FileText
  const typeLabel = session.type === 'audio' ? 'Sprachaufnahme' : 'PDF-Dokument'

  const displayTitle =
    session.title && session.title.trim().length > 0 ? session.title : 'Unbenannte Transkription'
  const summary = session.summary?.trim()
  const hasSummary = summary != null && summary.length > 0
  const fullTimestamp = new Date(session.createdAt).toLocaleString('de-CH', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })

  // ---- Status-Zeile-Inhalt ableiten -------------------------------------
  // Drei Zustände: review, queued (mit/ohne Position), processing (mit/ohne current).
  // Phase F deckt review + processing happy path ab; queued kommt in Phase K.
  const isProcessing = session.status === 'processing'
  const isQueued = session.status === 'queued'
  const isReview = session.status === 'review'

  // Phase L: Empty-speech is signalled via wordCount === 0 on a review session.
  // Visual treatment: Info icon + headline in the status row, body text below.
  const isEmptySpeech = isReview && session.wordCount === 0

  let statusContent: React.ReactNode
  if (isReview) {
    if (isEmptySpeech) {
      statusContent = (
        <>
          <Info
            className="h-3.5 w-3.5 text-text-secondary"
            strokeWidth={1.75}
            aria-hidden="true"
          />
          <span className="text-xs font-medium text-text-secondary">
            {PIPELINE_UI_STRINGS.emptySpeechHeadline}
          </span>
        </>
      )
    } else {
      statusContent =
        session.wordCount != null ? (
          <span className="text-xs text-text-tertiary">
            {session.wordCount.toLocaleString('de-CH')} Wörter
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
  // Phase F: schritt-eigene Bar bei processing (nicht transitioning).
  // Phase J wird die Gesamt-Bar + ETA in derselben Zeile ergänzen, sobald der
  // Estimator kalibriert ist (current.etaSecondsTotal != null).
  const showStepBar = isProcessing && current != null && !current.isTransitioning
  const showTransitionBar = isProcessing && current != null && current.isTransitioning
  const stepProgressPct = current ? Math.round(current.progress * 100) : 0
  const stepLabel = current ? STEP_LABELS_DE[current.taskType] : ''
  const etaText = current ? formatEta(current.etaSecondsTotal) : null

  return (
    <div
      className={`group relative rounded-lg border border-border bg-surface-0 px-4 py-3 transition-colors hover:border-border-strong has-[button:focus-visible]:border-primary ${onClick ? 'hover:shadow-sm' : ''}`}
      data-session-id={dataSessionId}
    >
      {onClick && (
        <button
          type="button"
          onClick={onClick}
          aria-label={`${displayTitle} öffnen`}
          className="absolute inset-0 z-0 rounded-lg focus:outline-none"
        />
      )}

      <div className="pointer-events-none relative z-[1] flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-text-primary">{displayTitle}</p>
          {hasSummary && (
            <p className="mt-0.5 line-clamp-1 text-xs leading-snug text-text-secondary">
              {summary}
            </p>
          )}
        </div>

        <div className="relative shrink-0">
          <time
            className="block whitespace-nowrap text-xs text-text-tertiary transition-opacity group-hover:opacity-0"
            dateTime={session.createdAt}
            title={fullTimestamp}
          >
            {formatCardTimestamp(session.createdAt)}
          </time>
          <button
            className="pointer-events-auto absolute -right-1.5 -top-1.5 z-10 rounded p-1.5 text-text-tertiary opacity-0 transition-opacity hover:bg-error-bg hover:text-error-text group-hover:opacity-100 focus-visible:opacity-100"
            onClick={onDelete}
            aria-label="Transkription löschen"
            title="Löschen"
          >
            <Trash2 className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="pointer-events-none relative z-[1] mt-1.5 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">{statusContent}</div>

        <TypeIcon
          className="h-3.5 w-3.5 shrink-0 text-text-tertiary"
          strokeWidth={1.75}
          role="img"
          aria-label={typeLabel}
        />
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
      {/* Phase M: 3-stage retry-limit UX driven by Session.retryCount */}
      {session.status === 'error' && session.retryCount === 1 && (
        <p className="pointer-events-none relative z-[1] mt-1 text-xs text-text-tertiary">
          {PIPELINE_UI_STRINGS.retryAfterFirstFailure}
        </p>
      )}
      {session.status === 'error' && session.retryCount === 2 && (
        <p className="pointer-events-none relative z-[1] mt-1 text-xs text-text-tertiary">
          {PIPELINE_UI_STRINGS.retryAfterSecondFailure}
        </p>
      )}
      {session.status === 'error' && session.retryCount < 3 && onRetry && (
        <button
          className="pointer-events-auto relative z-10 mt-1.5 text-xs font-medium text-primary hover:text-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
          onClick={onRetry}
          disabled={retryDisabled}
          title={retryDisabled ? 'Eine andere Transkription wird gerade verarbeitet' : undefined}
        >
          {PIPELINE_UI_STRINGS.retryButton}
        </button>
      )}
      {session.status === 'error' && session.retryCount >= 3 && (
        <p
          className="pointer-events-none relative z-[1] mt-1.5 text-xs text-text-tertiary"
          role="alert"
        >
          {PIPELINE_UI_STRINGS.retryExhausted}
        </p>
      )}

      {showStepBar && (
        <div className="pointer-events-none relative z-[1] mt-2 flex items-center gap-2">
          <div
            className="h-1 flex-1 overflow-hidden rounded-full bg-surface-2"
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
          {etaText && (
            <span
              className="whitespace-nowrap text-xs text-text-tertiary"
              title="Geschätzt aus früheren Sitzungen auf diesem Mac. Tatsächliche Dauer kann abweichen."
            >
              {etaText}
            </span>
          )}
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
    </div>
  )
}
