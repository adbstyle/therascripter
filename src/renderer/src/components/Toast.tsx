import { useCallback, useEffect, useRef, useState } from 'react'
import { Info, X } from 'lucide-react'

export interface ToastData {
  id: number
  message: string
  type: 'success' | 'error' | 'info'
  /** Standard 3000 ms. */
  durationMs?: number
}

interface ToastProps {
  toast: ToastData
  onDismiss: (id: number) => void
}

/**
 * Kurzer Hinweis unten rechts. Fehler-Hinweise tragen oft eine
 * Handlungsanweisung (z. B. «… nicht zugeordnet — so holen Sie es nach»):
 * sie bleiben stehen, solange Maus oder Tastaturfokus auf ihnen liegen,
 * haben einen Schliessen-Knopf und sind per Tab erreichbar (Review #225).
 * Erfolgs-Hinweise verschwinden wie bisher von selbst.
 */
export function Toast({ toast, onDismiss }: ToastProps): React.JSX.Element {
  const [visible, setVisible] = useState(false)
  const actionable = toast.type === 'error'
  const duration = toast.durationMs ?? 3000
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const remaining = useRef(duration)
  const startedAt = useRef(0)
  const hovered = useRef(false)
  const focused = useRef(false)

  const close = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    setVisible(false)
    // Remove after fade-out animation
    setTimeout(() => onDismiss(toast.id), 200)
  }, [onDismiss, toast.id])

  const run = useCallback(() => {
    if (timer.current) return
    startedAt.current = Date.now()
    timer.current = setTimeout(close, remaining.current)
  }, [close])

  const pause = useCallback(() => {
    if (!timer.current) return
    clearTimeout(timer.current)
    timer.current = null
    remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt.current))
  }, [])

  const update = useCallback(() => {
    if (hovered.current || focused.current) pause()
    else run()
  }, [pause, run])

  useEffect(() => {
    // Trigger enter animation
    requestAnimationFrame(() => setVisible(true))
    remaining.current = duration
    run()
    return () => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
    }
  }, [toast.id, duration, run])

  const bgColor = toast.type === 'error' ? 'bg-recording-solid' : 'bg-tooltip-bg'

  const pauseHandlers = actionable
    ? {
        onMouseEnter: (): void => {
          hovered.current = true
          update()
        },
        onMouseLeave: (): void => {
          hovered.current = false
          update()
        },
        onFocus: (): void => {
          focused.current = true
          update()
        },
        onBlur: (e: React.FocusEvent<HTMLDivElement>): void => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
          focused.current = false
          update()
        }
      }
    : {}

  return (
    <div
      role="status"
      aria-live="polite"
      {...pauseHandlers}
      className={`${bgColor} max-w-md rounded-lg px-4 py-3 text-sm text-white shadow-xl ring-1 ring-black/10 transition-all duration-200 ${
        visible ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'
      }`}
    >
      <div className="flex items-start gap-2">
        {toast.type === 'success' ? (
          <span aria-hidden="true">&#10003;</span>
        ) : toast.type === 'info' ? (
          <Info className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2} aria-hidden />
        ) : (
          <span aria-hidden="true">&#10007;</span>
        )}
        <span className="flex-1">{toast.message}</span>
        {actionable && (
          <button
            type="button"
            aria-label="Meldung schliessen"
            title="Meldung schliessen"
            onClick={close}
            className="-mr-1 -mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-white/90 hover:bg-white/15 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            <X className="h-4 w-4" strokeWidth={2} aria-hidden />
          </button>
        )}
      </div>
    </div>
  )
}
