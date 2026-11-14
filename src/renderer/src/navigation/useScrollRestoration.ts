import { createContext, useContext, useLayoutEffect, useRef } from 'react'

/**
 * Der einzige Scroll-Container der Shell (`PageScroll`) teilt hierüber mit,
 * zu welchem Verlaufseintrag die Seite gehört und wo sie zuletzt stand.
 */
export interface PageScrollInfo {
  entryId: number
  anchorId: string | undefined
  /** Der Scroll-Container; null bis er gemountet ist. */
  element: HTMLElement | null
  /** Letzte Scroll-Position je Verlaufseintrag. */
  positions: Map<number, number>
}

export const PageScrollContext = createContext<PageScrollInfo | null>(null)

/**
 * Stellt die Scroll-Position einer Seite wieder her, sobald ihre Daten
 * geladen sind (`ready`), und holt die Karte, von der aus weiternavigiert
 * wurde (`anchorId`), sichtbar und hervorgehoben zurück — «seine Stelle
 * wiederfinden» nach dem Schliessen einer Sitzung (#205 AK 16).
 *
 * Läuft einmal pro Besuch: `PageScroll` wird pro Verlaufseintrag neu
 * gemountet und damit auch die Seite, die diesen Hook aufruft.
 */
export function useScrollRestoration(ready: boolean): void {
  const info = useContext(PageScrollContext)
  const done = useRef(false)

  useLayoutEffect(() => {
    if (!info || !ready || done.current) return
    const container = info.element
    if (!container) return
    done.current = true

    const saved = info.positions.get(info.entryId)
    if (saved !== undefined) container.scrollTop = saved

    if (!info.anchorId) return
    const card = Array.from(container.querySelectorAll<HTMLElement>('[data-session-id]')).find(
      (el) => el.dataset.sessionId === info.anchorId
    )
    if (!card) return
    if (!isFullyVisible(card, container)) {
      card.scrollIntoView({ block: 'center', behavior: 'instant' })
    }
    card.classList.add('session-highlight')
    card.addEventListener('animationend', () => card.classList.remove('session-highlight'), {
      once: true
    })
  }, [info, ready])
}

function isFullyVisible(el: HTMLElement, container: HTMLElement): boolean {
  const box = el.getBoundingClientRect()
  const view = container.getBoundingClientRect()
  return box.top >= view.top && box.bottom <= view.bottom
}
