import { useCallback, useLayoutEffect, useState } from 'react'
import type { RefObject } from 'react'

/** Abstand zum Fensterrand und zum Auslöser (px). */
export const POPOVER_VIEWPORT_MARGIN = 8
const GAP = 4

export interface PopoverPlacement {
  /** Unter (`bottom`) oder über (`top`) dem Auslöser. */
  side: 'bottom' | 'top'
  /** Verschiebung nach links/rechts relativ zum Auslöser, damit es im Fenster bleibt. */
  offsetX: number
  /** Höchstens so hoch wie der Platz auf der gewählten Seite (Inhalt scrollt intern). */
  maxHeight: number | undefined
}

export interface PlacementInput {
  /** Rechteck des Auslösers (Bezugselement des absolut positionierten Popovers). */
  anchor: { top: number; bottom: number; left: number }
  /** Breite des Popovers. */
  width: number
  /** Höhe, die das Popover ohne Begrenzung bräuchte. */
  naturalHeight: number
  /** Sichtbarer Bereich: Fenster, geschnitten mit abschneidenden Scroll-Containern. */
  bounds: { top: number; bottom: number; left: number; right: number }
}

/**
 * Wählt die Seite mit genug Platz: unten, wenn das Popover dort ganz hinpasst
 * oder unten mehr Platz ist als oben; sonst oben. Horizontal bleibt es im
 * Fenster; die Höhe ist auf den Platz der gewählten Seite begrenzt.
 */
export function computePopoverPlacement(input: PlacementInput): PopoverPlacement {
  const { anchor, width, naturalHeight, bounds } = input
  const below = bounds.bottom - anchor.bottom - GAP - POPOVER_VIEWPORT_MARGIN
  const above = anchor.top - bounds.top - GAP - POPOVER_VIEWPORT_MARGIN
  const side: PopoverPlacement['side'] = naturalHeight <= below || below >= above ? 'bottom' : 'top'
  const space = Math.max(0, side === 'bottom' ? below : above)
  let offsetX = 0
  const right = anchor.left + width
  if (right > bounds.right - POPOVER_VIEWPORT_MARGIN) {
    offsetX = bounds.right - POPOVER_VIEWPORT_MARGIN - right
  }
  if (anchor.left + offsetX < bounds.left + POPOVER_VIEWPORT_MARGIN) {
    offsetX = bounds.left + POPOVER_VIEWPORT_MARGIN - anchor.left
  }
  return { side, offsetX: Math.round(offsetX), maxHeight: Math.floor(space) }
}

/**
 * Sichtbarer Bereich für ein Popover in `el`: das Fenster, geschnitten mit
 * jedem Vorfahren, der seinen Inhalt abschneidet (overflow ≠ visible) — ein
 * Popover in einer scrollenden Liste würde sonst von ihr abgeschnitten.
 */
function visibleBounds(el: HTMLElement): PlacementInput['bounds'] {
  const bounds = { top: 0, left: 0, bottom: window.innerHeight, right: window.innerWidth }
  for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
    const style = getComputedStyle(node)
    const clipsY = style.overflowY !== 'visible' && style.overflowY !== ''
    const clipsX = style.overflowX !== 'visible' && style.overflowX !== ''
    if (!clipsX && !clipsY) continue
    const r = node.getBoundingClientRect()
    // Elemente ohne Ausmass (jsdom, display: contents) begrenzen nichts
    if (r.width === 0 && r.height === 0) continue
    if (clipsY) {
      bounds.top = Math.max(bounds.top, r.top)
      bounds.bottom = Math.min(bounds.bottom, r.bottom)
    }
    if (clipsX) {
      bounds.left = Math.max(bounds.left, r.left)
      bounds.right = Math.min(bounds.right, r.right)
    }
  }
  return bounds
}

/**
 * Platzierung eines absolut positionierten Popovers an seinem Bezugselement
 * (`offsetParent` bzw. Elternelement) — beim Öffnen und erneut nach Scrollen
 * (auch in inneren Scroll-Containern) und Resize. `scrollRef` ist der
 * Bereich, der intern scrollt: seine volle Inhaltshöhe zählt zur
 * natürlichen Höhe (bis zu seiner eigenen max-height), damit die Wahl nicht
 * von der aktuellen Begrenzung abhängt.
 */
export function usePopoverPlacement(
  popoverRef: RefObject<HTMLElement | null>,
  scrollRef: RefObject<HTMLElement | null>,
  /** Ändert sich der Inhalt (z. B. Liste geladen, gefiltert), wird neu gemessen. */
  contentKey?: unknown
): PopoverPlacement {
  const [placement, setPlacement] = useState<PopoverPlacement>({
    side: 'bottom',
    offsetX: 0,
    maxHeight: undefined
  })

  const measure = useCallback(() => {
    const el = popoverRef.current
    const anchorEl = el?.parentElement
    if (!el || !anchorEl) return
    const anchor = anchorEl.getBoundingClientRect()
    const scroller = scrollRef.current
    let extra = 0
    if (scroller) {
      // Der Scrollbereich hat eine eigene Obergrenze (CSS max-height): bis dorthin wächst er
      const cap = parseFloat(getComputedStyle(scroller).maxHeight)
      const natural = Math.min(scroller.scrollHeight, Number.isFinite(cap) ? cap : Infinity)
      extra = Math.max(0, natural - scroller.clientHeight)
    }
    const next = computePopoverPlacement({
      anchor,
      width: el.offsetWidth,
      naturalHeight: el.offsetHeight + extra,
      bounds: visibleBounds(anchorEl)
    })
    setPlacement((prev) =>
      prev.side === next.side && prev.offsetX === next.offsetX && prev.maxHeight === next.maxHeight
        ? prev
        : next
    )
  }, [popoverRef, scrollRef])

  useLayoutEffect(() => {
    measure()
    let frame = 0
    const schedule = (): void => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        measure()
      })
    }
    window.addEventListener('resize', schedule)
    // capture: auch Scrollen in Containern (Liste, Editor), nicht nur im Fenster
    window.addEventListener('scroll', schedule, true)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
    }
  }, [measure])

  useLayoutEffect(() => {
    measure()
  }, [measure, contentKey])

  return placement
}
