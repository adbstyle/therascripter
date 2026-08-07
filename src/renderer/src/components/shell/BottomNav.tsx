import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, Files, Settings } from 'lucide-react'
import { useAppUpdate } from '../../hooks/useAppUpdate'
import { useReconcileEvents } from '../../hooks/useReconcileEvents'

type View = 'sessions' | 'settings'

interface BottomNavProps {
  current: View
  onChange: (view: View) => void
}

const FEEDBACK_EMAIL = 'therascript.flatworm325@passmail.com'

const ITEMS: { id: View; icon: typeof Files; label: string }[] = [
  { id: 'sessions', icon: Files, label: 'Transkriptionen' },
  { id: 'settings', icon: Settings, label: 'Einstellungen' }
]

export default function BottomNav({ current, onChange }: BottomNavProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<Record<View, HTMLButtonElement | null>>({
    sessions: null,
    settings: null
  })
  const [pill, setPill] = useState<{ x: number; w: number } | null>(null)
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const copyResetRef = useRef<number | null>(null)
  const { status: appUpdateStatus, openReleasePage } = useAppUpdate()
  const { pendingCount: reconcilePending } = useReconcileEvents()

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

  useLayoutEffect(() => {
    const node = itemRefs.current[current]
    const container = containerRef.current
    if (!node || !container) return
    const containerRect = container.getBoundingClientRect()
    const nodeRect = node.getBoundingClientRect()
    setPill({ x: nodeRect.left - containerRect.left, w: nodeRect.width })
  }, [current])

  useEffect(() => {
    window.api.system.aboutInfo().then((info) => setAppVersion(info.version))
  }, [])

  const updateAvailable = appUpdateStatus?.available === true

  return (
    <div className="flex shrink-0 items-center justify-between gap-4 bg-surface-1 px-4 py-2">
      <nav
        ref={containerRef}
        aria-label="Hauptnavigation"
        className="relative inline-flex items-center gap-1"
      >
        {pill && (
          <span
            aria-hidden
            className="pointer-events-none absolute top-0 h-full rounded-full bg-surface-2 transition-[transform,width] duration-[280ms] ease-[cubic-bezier(0.34,1.56,0.64,1)]"
            style={{
              width: pill.w,
              transform: `translateX(${pill.x}px)`
            }}
          />
        )}

        {ITEMS.map((item) => {
          const isActive = current === item.id
          const Icon = item.icon
          // Issue #84 / Story C — passive awareness that the reconciler made
          // an invariant repair the user hasn't yet acknowledged. Cleared
          // when Settings → Modelle is mounted (markReconcileEventsSeen).
          const showReconcileDot = item.id === 'settings' && reconcilePending > 0

          return (
            <button
              key={item.id}
              ref={(el) => {
                itemRefs.current[item.id] = el
              }}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls={`view-${item.id}`}
              data-active={isActive}
              data-id={item.id}
              onClick={() => onChange(item.id)}
              className="bottom-nav-item titlebar-no-drag relative z-10 flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium text-text-tertiary transition-colors duration-200 hover:text-text-secondary data-[active=true]:text-text-primary"
            >
              <span
                key={`icon-${item.id}-${isActive}`}
                className="bottom-nav-icon relative inline-flex"
              >
                <Icon className="h-4 w-4" strokeWidth={isActive ? 2 : 1.75} aria-hidden="true" />
                {showReconcileDot && (
                  <span
                    aria-label="Automatische Anpassung — Hinweis in Modelle"
                    title="Automatische Anpassung — Hinweis in Modelle"
                    className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-primary"
                  />
                )}
              </span>
              <span>{item.label}</span>
            </button>
          )
        })}
      </nav>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleCopyFeedback}
          aria-label={
            copied
              ? 'Feedback-Adresse in die Zwischenablage kopiert'
              : `Feedback-Adresse ${FEEDBACK_EMAIL} in die Zwischenablage kopieren`
          }
          className="titlebar-no-drag inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs text-text-tertiary transition-colors hover:bg-surface-2 hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          {copied ? (
            <>
              <Check className="h-3 w-3 text-primary" strokeWidth={2.5} aria-hidden="true" />
              <span className="text-primary">Adresse kopiert</span>
            </>
          ) : (
            <span>
              Feedback: <span className="underline decoration-dotted">{FEEDBACK_EMAIL}</span>
            </span>
          )}
        </button>
        {updateAvailable ? (
          <button
            type="button"
            onClick={openReleasePage}
            className="titlebar-no-drag flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary-light/30 hover:text-primary-hover"
          >
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-primary" />
            <span>Update verfügbar</span>
          </button>
        ) : (
          <span className="px-2 text-xs text-text-tertiary">v{appVersion ?? '…'}</span>
        )}
      </div>
    </div>
  )
}
