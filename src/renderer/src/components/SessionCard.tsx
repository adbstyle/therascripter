import { useRef, useState } from 'react'
import type { Session, SessionStatus, TaskType } from '../../../shared/types'
import { useClickOutside } from '../hooks/useClickOutside'
import { useTaskProgress } from '../hooks/useTaskProgress'

interface SessionCardProps {
  session: Session
  onRename: () => void
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

export function SessionCard({
  session,
  onRename,
  onDelete,
  onClick,
  onRetry,
  retryDisabled,
  'data-session-id': dataSessionId
}: SessionCardProps): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const showProgress = isProcessingStatus(session.status)
  const { tasks, currentProgress } = useTaskProgress(showProgress ? session.id : null)

  useClickOutside(menuRef, () => setMenuOpen(false))

  const statusConfig = STATUS_CONFIG[session.status]
  const typeIcon = session.type === 'audio' ? '\uD83C\uDFA4' : '\uD83D\uDCC4'
  const pipelineSteps = session.type === 'audio' ? AUDIO_PIPELINE_STEPS : PDF_PIPELINE_STEPS

  // Build status label with progress percentage
  let statusLabel = statusConfig.label
  if (showProgress && currentProgress) {
    const pct = Math.round(currentProgress.progress * 100)
    statusLabel = `${TASK_LABELS[currentProgress.taskType]} ${pct}%`
  }

  return (
    <div
      className={`group relative flex items-center gap-3 rounded-lg border border-border bg-surface-0 px-4 py-3 transition-colors hover:border-border-strong ${onClick ? 'cursor-pointer hover:shadow-sm' : ''}`}
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
      <span className="text-lg" aria-hidden="true">
        {typeIcon}
      </span>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-text-primary">{session.title}</p>
        <div className="flex items-center gap-2">
          <span className={`text-xs font-medium ${statusConfig.color}`}>{statusLabel}</span>
          {session.wordCount != null && session.status === 'review' && (
            <span className="text-xs text-text-tertiary">
              · {session.wordCount.toLocaleString('de-CH')} Wörter
            </span>
          )}
        </div>
        {session.status === 'error' && session.errorMessage && (
          <p className="mt-0.5 line-clamp-3 text-xs text-text-tertiary">{session.errorMessage}</p>
        )}
        {session.status === 'error' && onRetry && (
          <button
            className="mt-1.5 text-xs font-medium text-primary hover:text-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
            onClick={(e) => {
              e.stopPropagation()
              onRetry()
            }}
            disabled={retryDisabled}
            title={retryDisabled ? 'Eine andere Sitzung wird gerade verarbeitet' : undefined}
          >
            Erneut versuchen
          </button>
        )}

        {showProgress && (
          <div className="mt-2">
            {/* Progress bar */}
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

            {/* Pipeline step indicators */}
            <div className="flex items-center gap-1.5">
              {pipelineSteps.map((step) => {
                const task = tasks.find((t) => t.type === step)
                const isCompleted = task?.status === 'completed'
                const isRunning = task?.status === 'running'
                const isFailed = task?.status === 'failed'

                let dotClass = 'bg-surface-3' // pending
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

      <div className="relative" ref={menuRef}>
        <button
          className="rounded p-1 text-text-tertiary opacity-0 transition-opacity hover:bg-surface-2 hover:text-text-secondary group-hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation()
            setMenuOpen(!menuOpen)
          }}
          aria-label="Sitzungsoptionen"
        >
          <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 16 16">
            <circle cx="8" cy="3" r="1.5" />
            <circle cx="8" cy="8" r="1.5" />
            <circle cx="8" cy="13" r="1.5" />
          </svg>
        </button>

        {menuOpen && (
          <div
            className="absolute right-0 top-full z-10 mt-1 w-40 rounded-md border border-border bg-surface-1 py-1 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="w-full px-3 py-1.5 text-left text-sm text-text-secondary hover:bg-surface-2"
              onClick={() => {
                setMenuOpen(false)
                onRename()
              }}
            >
              Umbenennen
            </button>
            <button
              className="w-full px-3 py-1.5 text-left text-sm text-error-text hover:bg-error-bg"
              onClick={() => {
                setMenuOpen(false)
                onDelete()
              }}
            >
              Löschen
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
