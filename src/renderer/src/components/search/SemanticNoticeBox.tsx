import { AlertCircle, Info, RotateCw } from 'lucide-react'
import type { SemanticNotice } from '../../utils/searchNotice'

interface SemanticNoticeBoxProps {
  notice: SemanticNotice
  onRetryModel: () => void
  onRetrySemantic: () => void
  /** «Erneut versuchen» der Suche nach Bedeutung braucht eine Anfrage. */
  canRetrySemantic: boolean
}

/**
 * Hinweis, warum die Suche nach Bedeutung gerade nicht mitsucht (#209 AK 18,
 * #210 AK 4/5) — mit Grund und, wo es hilft, «Erneut versuchen». Texte wie
 * in der Statuskarte «Suchmodell» (Einstellungen → Modelle).
 */
export function SemanticNoticeBox({
  notice,
  onRetryModel,
  onRetrySemantic,
  canRetrySemantic
}: SemanticNoticeBoxProps): React.JSX.Element {
  const Icon = notice.tone === 'error' ? AlertCircle : Info
  const showRetry =
    notice.action === 'retry-model' || (notice.action === 'retry-semantic' && canRetrySemantic)
  return (
    <div
      role="note"
      aria-label={notice.title}
      className={`flex gap-2.5 rounded-lg border px-3 py-2.5 text-sm ${
        notice.tone === 'error'
          ? 'border-error-border bg-error-bg text-error-text-emphasis'
          : 'border-info-border bg-info-bg text-info-text'
      }`}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2} aria-hidden />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-semibold">{notice.title}</p>
        <p className="leading-relaxed">{notice.text}</p>
        {notice.progress !== undefined && (
          <div className="flex items-center gap-2 pt-1">
            <div
              className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2"
              role="progressbar"
              aria-valuenow={notice.progress}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Fortschritt beim Laden des Suchmodells"
            >
              <div
                className="h-full rounded-full bg-primary transition-all duration-300"
                style={{ width: `${notice.progress}%` }}
              />
            </div>
            <span className="text-xs">{notice.progress} %</span>
          </div>
        )}
        {showRetry && (
          <button
            type="button"
            onClick={notice.action === 'retry-model' ? onRetryModel : onRetrySemantic}
            className="mt-1 inline-flex items-center gap-1.5 rounded-md border border-border-strong bg-surface-0 px-2.5 py-1 text-xs font-medium text-text-primary transition-colors hover:bg-surface-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <RotateCw className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
            Erneut versuchen
          </button>
        )}
      </div>
    </div>
  )
}
