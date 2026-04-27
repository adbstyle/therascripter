import { AlertOctagon, AlertTriangle, RotateCw } from 'lucide-react'

export type QualityBannerSeverity = 'warning' | 'critical'

interface QualityWarningBannerProps {
  severity: QualityBannerSeverity
  onRetry?: () => void
  retryDisabled?: boolean
}

const COPY: Record<QualityBannerSeverity, { heading: string; body: string }> = {
  warning: {
    heading: 'Mögliche Transkriptionsfehler',
    body: 'Whisper hat in dieser Aufnahme ungewöhnlich viele Wiederholungen erkannt. Bitte prüfen Sie das Transkript sorgfältig gegen die Originalaufnahme.'
  },
  critical: {
    heading: 'Transkription fehlerhaft',
    body: 'Whisper hat in dieser Aufnahme einen Wiederholungs-Loop erkannt — der gleiche Satz wiederholt sich zu oft, um verlässlich zu sein. Das Transkript wird zur Inspektion angezeigt, ist aber nicht für die weitere Verarbeitung verwendet worden.'
  }
}

export function QualityWarningBanner({
  severity,
  onRetry,
  retryDisabled
}: QualityWarningBannerProps): React.JSX.Element {
  const isCritical = severity === 'critical'
  const Icon = isCritical ? AlertOctagon : AlertTriangle
  const containerClass = isCritical
    ? 'border-error-border bg-error-bg'
    : 'border-warning-border bg-warning-bg'
  const textClass = isCritical ? 'text-error-text' : 'text-warning-text'
  const buttonClass = isCritical
    ? 'border-error-border bg-surface-0 text-error-text hover:bg-error-bg/40'
    : 'border-warning-border bg-surface-0 text-warning-text hover:bg-warning-bg/40'
  const { heading, body } = COPY[severity]

  return (
    <div role="alert" className={`flex items-start gap-3 border-b ${containerClass} px-6 py-3`}>
      <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${textClass}`} strokeWidth={1.75} aria-hidden />
      <div className={`min-w-0 flex-1 text-sm ${textClass}`}>
        <p className="font-semibold">{heading}</p>
        <p className="mt-0.5 text-xs opacity-90">{body}</p>
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={retryDisabled}
          className={`shrink-0 inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${buttonClass}`}
          title={
            retryDisabled
              ? 'Eine andere Transkription wird gerade verarbeitet'
              : undefined
          }
        >
          <RotateCw className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden />
          Erneut transkribieren
        </button>
      )}
    </div>
  )
}
