import { useEffect, useRef, useState } from 'react'
import { Check, Settings } from 'lucide-react'
import { useAppUpdate } from '../../hooks/useAppUpdate'
import { useReconcileEvents } from '../../hooks/useReconcileEvents'
import { useNavigation } from '../../navigation/navigation'

export const FEEDBACK_EMAIL = 'therascript.flatworm325@passmail.com'

/**
 * Fuss der Seitenleiste: Einstellungen (mit Hinweispunkt nach einer
 * automatischen Modell-Anpassung, #84), Hinweis «Update bereit/verfügbar»
 * (#164 AK 5, #167) bzw. die Versionsnummer, Feedback-Adresse zum Kopieren.
 */
export default function SidebarFooter(): React.JSX.Element {
  const { route, navigate } = useNavigation()
  const { state: appUpdate, needsAttention: updateNeedsAttention } = useAppUpdate()
  const { pendingCount: reconcilePending } = useReconcileEvents()
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const copyResetRef = useRef<number | null>(null)
  const settingsActive = route.kind === 'settings'

  useEffect(() => {
    window.api.system
      .aboutInfo()
      .then((info) => setAppVersion(info.version))
      .catch(() => {})
  }, [])

  useEffect(
    () => () => {
      if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current)
    },
    []
  )

  const handleCopyFeedback = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(FEEDBACK_EMAIL)
    } catch {
      return
    }
    setCopied(true)
    if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current)
    copyResetRef.current = window.setTimeout(() => setCopied(false), 1800)
  }

  const updateHint = !updateNeedsAttention
    ? null
    : appUpdate?.phase === 'ready'
      ? 'Update bereit'
      : 'Update verfügbar'

  return (
    <div className="mt-3 flex flex-col gap-0.5 border-t border-border pt-2">
      <button
        type="button"
        onClick={() => navigate({ kind: 'settings', subpage: null })}
        aria-current={settingsActive ? 'page' : undefined}
        className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] leading-[18px] transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
          settingsActive ? 'bg-surface-2 font-medium text-text-primary' : 'text-text-secondary'
        }`}
      >
        <span className="relative inline-flex">
          <Settings className="h-4 w-4" strokeWidth={1.75} aria-hidden />
          {/* Issue #84 — automatische Anpassung noch nicht gesehen; Settings → Modelle räumt ihn */}
          {reconcilePending > 0 && (
            <span
              aria-label="Automatische Anpassung — Hinweis in Modelle"
              title="Automatische Anpassung — Hinweis in Modelle"
              className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-primary"
            />
          )}
        </span>
        Einstellungen
      </button>

      {updateHint && (
        <button
          type="button"
          onClick={() => navigate({ kind: 'settings', subpage: 'updates' })}
          className="flex items-center gap-2 rounded-md px-2.5 py-1 text-left text-xs font-medium text-primary transition-colors hover:bg-primary-light/30 hover:text-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <span aria-hidden className="ml-1 h-1.5 w-1.5 rounded-full bg-primary" />
          <span>{updateHint}</span>
        </button>
      )}

      <div className="flex min-w-0 items-center justify-between gap-2 px-2.5 py-1">
        <button
          type="button"
          onClick={handleCopyFeedback}
          aria-label={
            copied
              ? 'Feedback-Adresse in die Zwischenablage kopiert'
              : `Feedback-Adresse ${FEEDBACK_EMAIL} in die Zwischenablage kopieren`
          }
          title={copied ? undefined : FEEDBACK_EMAIL}
          className="-mx-1 flex min-w-0 items-center gap-1 rounded px-1 text-left text-xs text-text-tertiary transition-colors hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          {copied ? (
            <>
              <Check className="h-3 w-3 shrink-0 text-primary" strokeWidth={2.5} aria-hidden />
              <span className="text-primary">Adresse kopiert</span>
            </>
          ) : (
            <>
              <span className="shrink-0">Feedback:</span>
              <span className="truncate underline decoration-dotted">{FEEDBACK_EMAIL}</span>
            </>
          )}
        </button>
        {!updateHint && (
          <span className="shrink-0 text-xs text-text-tertiary">v{appVersion ?? '…'}</span>
        )}
      </div>
    </div>
  )
}
