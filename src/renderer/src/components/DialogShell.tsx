import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'

interface DialogShellProps {
  ariaLabel: string
  /** Escape-Taste und Klick auf das Overlay. */
  onDismiss: () => void
  /** Breite der Karte: `md` (Standard, Bestätigungen) oder `lg` (Formulare, Epic #192). */
  size?: 'md' | 'lg'
  children: ReactNode
}

const SIZE_CLASSES = { md: 'max-w-md', lg: 'max-w-lg' } as const

/**
 * Gemeinsame Modal-Hülle: Overlay, Escape-Handling, Klick-außerhalb,
 * ARIA-Attribute und Karten-Styling. War in ConfirmDialog, BlocklistDialog
 * und BlocklistConfirmDialog dreifach handgerollt (identische Klassen und
 * Event-Verkabelung). Fokus-Management bleibt bei den Dialogen — jeder
 * fokussiert bewusst ein anderes Element (Cancel / Confirm / Input).
 */
export function DialogShell({
  ariaLabel,
  onDismiss,
  size = 'md',
  children
}: DialogShellProps): React.JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const previous = document.activeElement
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') onDismiss()
      if (e.key === 'Tab') trapFocus(e, cardRef.current)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onDismiss])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      onClick={onDismiss}
    >
      <div
        ref={cardRef}
        className={`mx-4 w-full ${SIZE_CLASSES[size]} rounded-xl bg-surface-1 p-6 shadow-xl`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Tab am Ende springt an den Anfang der Karte, Shift-Tab am Anfang ans Ende. */
function trapFocus(e: KeyboardEvent, card: HTMLElement | null): void {
  if (!card) return
  const focusable = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE))
  if (focusable.length === 0) {
    e.preventDefault()
    return
  }
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  const active = document.activeElement
  // Liegt der Fokus in einem anderen (darüber geöffneten) Dialog, ist der zuständig
  const owner = active instanceof HTMLElement ? active.closest('[role="dialog"]') : null
  if (owner && !owner.contains(card)) return
  if (e.shiftKey && (active === first || !card.contains(active))) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && (active === last || !card.contains(active))) {
    e.preventDefault()
    first.focus()
  }
}
