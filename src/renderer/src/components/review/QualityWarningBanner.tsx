import { AlertOctagon, AlertTriangle } from 'lucide-react'

export type QualityBannerSeverity = 'warning' | 'critical'

interface QualityWarningBannerProps {
  severity: QualityBannerSeverity
}

const COPY: Record<QualityBannerSeverity, { heading: string; body: string }> = {
  warning: {
    heading: 'Mögliche Transkriptionsfehler',
    body: 'Whisper hat in dieser Aufnahme ungewöhnlich viele Wiederholungen erkannt. Bitte prüfen Sie das Transkript sorgfältig gegen die Originalaufnahme.'
  },
  critical: {
    heading: 'Transkriptionsqualität schlecht',
    body: 'Whisper hat in dieser Aufnahme einen Wiederholungs-Loop erkannt — der gleiche Satz wiederholt sich zu oft, um verlässlich zu sein. Sie sehen das Ergebnis trotzdem im Editor und können es als Bug melden.'
  }
}

export function QualityWarningBanner({
  severity
}: QualityWarningBannerProps): React.JSX.Element {
  const isCritical = severity === 'critical'
  const Icon = isCritical ? AlertOctagon : AlertTriangle
  const containerClass = isCritical
    ? 'border-error-border bg-error-bg'
    : 'border-warning-border bg-warning-bg'
  const textClass = isCritical ? 'text-error-text' : 'text-warning-text'
  const { heading, body } = COPY[severity]

  return (
    <div role="alert" className={`flex items-start gap-3 border-b ${containerClass} px-6 py-3`}>
      <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${textClass}`} strokeWidth={1.75} aria-hidden />
      <div className={`min-w-0 flex-1 text-sm ${textClass}`}>
        <p className="font-semibold">{heading}</p>
        <p className="mt-0.5 text-xs opacity-90">{body}</p>
      </div>
    </div>
  )
}
