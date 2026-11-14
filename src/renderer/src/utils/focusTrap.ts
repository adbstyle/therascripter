/** Fokusfalle der Dialoge (DialogShell, Suchfenster). */

export const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Tab am Ende springt an den Anfang der Karte, Shift-Tab am Anfang ans Ende. */
export function trapFocus(e: KeyboardEvent, card: HTMLElement | null): void {
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
