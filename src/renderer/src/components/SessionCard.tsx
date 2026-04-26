import { FileText, Mic, Trash2 } from 'lucide-react'
import type { Session, SessionStatus, TaskType } from '../../../shared/types'
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
  transcribing: { label: 'Transkription', color: 'text-primary' },
  diarizing: { label: 'Sprechererkennung', color: 'text-primary' },
  extracting: { label: 'Textextraktion', color: 'text-primary' },
  anonymizing: { label: 'Anonymisierung', color: 'text-primary' },
  review: { label: 'Review', color: 'text-success' },
  error: { label: 'Fehler', color: 'text-error-text' }
}

const TASK_LABELS: Record<TaskType, string> = {
  transcription: 'Transkription',
  diarization: 'Sprechererkennung',
  alignment: 'Zuordnung',
  extraction: 'Textextraktion',
  ocr: 'OCR',
  anonymization: 'Anonymisierung',
  summarization: 'Zusammenfassung'
}

const AUDIO_PIPELINE_STEPS: TaskType[] = [
  'transcription',
  'diarization',
  'alignment',
  'anonymization',
  'summarization'
]

const PDF_PIPELINE_STEPS: TaskType[] = ['extraction', 'ocr', 'anonymization', 'summarization']

function isProcessingStatus(status: SessionStatus): boolean {
  return (
    status === 'transcribing' ||
    status === 'diarizing' ||
    status === 'extracting' ||
    status === 'anonymizing'
  )
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
  const showProgress = isProcessingStatus(session.status)
  const { tasks, currentProgress } = useTaskProgress(showProgress ? session.id : null)

  const statusConfig = STATUS_CONFIG[session.status]
  const TypeIcon = session.type === 'audio' ? Mic : FileText
  const typeLabel = session.type === 'audio' ? 'Sprachaufnahme' : 'PDF-Dokument'
  const pipelineSteps = session.type === 'audio' ? AUDIO_PIPELINE_STEPS : PDF_PIPELINE_STEPS

  let statusLabel = statusConfig.label
  if (showProgress && currentProgress) {
    const pct = Math.round(currentProgress.progress * 100)
    statusLabel = `${TASK_LABELS[currentProgress.taskType]} ${pct}%`
  }

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

  return (
    <div
      className={`group relative rounded-lg border border-border bg-surface-0 px-4 py-3 transition-colors hover:border-border-strong ${onClick ? 'cursor-pointer hover:shadow-sm' : ''}`}
      data-session-id={dataSessionId}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter') onClick()
            }
          : undefined
      }
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-text-primary">{displayTitle}</p>
          {hasSummary && (
            <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-text-secondary">
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
            className="absolute -right-1.5 -top-1.5 rounded p-1.5 text-text-tertiary opacity-0 transition-opacity hover:bg-error-bg hover:text-error-text group-hover:opacity-100 focus-visible:opacity-100"
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
            aria-label="Transkription löschen"
            title="Löschen"
          >
            <Trash2 className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="mt-1.5 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {session.status === 'review' ? (
            session.wordCount != null && (
              <span className="text-xs text-text-tertiary">
                {session.wordCount.toLocaleString('de-CH')} Wörter
              </span>
            )
          ) : (
            <span className={`text-xs font-medium ${statusConfig.color}`}>{statusLabel}</span>
          )}
        </div>

        <TypeIcon
          className="h-3.5 w-3.5 shrink-0 text-text-tertiary"
          strokeWidth={1.75}
          role="img"
          aria-label={typeLabel}
        />
      </div>

      {session.status === 'error' && session.errorMessage && (
        <p className="mt-1 line-clamp-3 text-xs text-text-tertiary">{session.errorMessage}</p>
      )}
      {session.status === 'error' && onRetry && (
        <button
          className="mt-1.5 text-xs font-medium text-primary hover:text-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
          onClick={(e) => {
            e.stopPropagation()
            onRetry()
          }}
          disabled={retryDisabled}
          title={retryDisabled ? 'Eine andere Transkription wird gerade verarbeitet' : undefined}
        >
          Erneut versuchen
        </button>
      )}

      {showProgress && (
        <div className="mt-2">
          {currentProgress && (
            <div
              className="mb-1.5 h-1 w-full overflow-hidden rounded-full bg-surface-2"
              role="progressbar"
              aria-valuenow={Math.round(currentProgress.progress * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className="h-full rounded-full bg-primary transition-all duration-300"
                style={{ width: `${Math.round(currentProgress.progress * 100)}%` }}
              />
            </div>
          )}

          <div className="flex items-center gap-1.5">
            {pipelineSteps.map((step) => {
              const task = tasks.find((t) => t.type === step)
              const isCompleted = task?.status === 'completed'
              const isRunning = task?.status === 'running'
              const isFailed = task?.status === 'failed'

              let dotClass = 'bg-surface-3'
              if (isCompleted) dotClass = 'bg-success'
              else if (isRunning) dotClass = 'bg-primary animate-pulse'
              else if (isFailed) dotClass = 'bg-red-500'

              return (
                <div
                  key={step}
                  className={`h-1.5 w-1.5 rounded-full ${dotClass}`}
                  title={TASK_LABELS[step]}
                />
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
