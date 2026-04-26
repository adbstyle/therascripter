import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Files, Settings } from 'lucide-react'
import { useAppUpdate } from '../../hooks/useAppUpdate'

type View = 'sessions' | 'settings'

interface BottomNavProps {
  current: View
  onChange: (view: View) => void
}

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
  const { status: appUpdateStatus, openReleasePage } = useAppUpdate()

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
                className="bottom-nav-icon inline-flex"
              >
                <Icon
                  className="h-4 w-4"
                  strokeWidth={isActive ? 2 : 1.75}
                  aria-hidden="true"
                />
              </span>
              <span>{item.label}</span>
            </button>
          )
        })}
      </nav>

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
  )
}
