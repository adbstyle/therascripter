import { useEffect } from 'react'
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
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') onDismiss()
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
        className={`mx-4 w-full ${SIZE_CLASSES[size]} rounded-xl bg-surface-1 p-6 shadow-xl`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}
