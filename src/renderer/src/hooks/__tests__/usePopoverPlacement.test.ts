import { describe, it, expect } from 'vitest'
import { computePopoverPlacement } from '../usePopoverPlacement'

/** Zuordnen-Popover am Fensterrand (Sichtprüfung): Seite, Verschiebung, Höhe. */
const viewport = { top: 0, left: 0, right: 1100, bottom: 720 }

describe('computePopoverPlacement', () => {
  it('öffnet nach unten, wenn es dort ganz hinpasst', () => {
    const p = computePopoverPlacement({
      anchor: { top: 100, bottom: 120, left: 300 },
      width: 380,
      naturalHeight: 340,
      bounds: viewport
    })
    expect(p.side).toBe('bottom')
    expect(p.offsetX).toBe(0)
    expect(p.maxHeight).toBe(720 - 120 - 4 - 8)
  })

  it('klappt am unteren Rand nach oben, wenn oben mehr Platz ist', () => {
    const p = computePopoverPlacement({
      anchor: { top: 395, bottom: 415, left: 290 },
      width: 380,
      naturalHeight: 340,
      bounds: viewport
    })
    expect(p.side).toBe('top')
    expect(p.maxHeight).toBe(395 - 4 - 8)
  })

  it('bleibt unten, wenn unten mehr Platz ist, und begrenzt die Höhe (internes Scrollen)', () => {
    const p = computePopoverPlacement({
      anchor: { top: 200, bottom: 220, left: 20 },
      width: 380,
      naturalHeight: 900,
      bounds: viewport
    })
    expect(p.side).toBe('bottom')
    expect(p.maxHeight).toBe(720 - 220 - 12)
  })

  it('hält das Popover horizontal im Fenster', () => {
    const right = computePopoverPlacement({
      anchor: { top: 100, bottom: 120, left: 900 },
      width: 380,
      naturalHeight: 200,
      bounds: viewport
    })
    expect(900 + right.offsetX + 380).toBe(1100 - 8)
    const left = computePopoverPlacement({
      anchor: { top: 100, bottom: 120, left: 2 },
      width: 380,
      naturalHeight: 200,
      bounds: viewport
    })
    expect(2 + left.offsetX).toBe(8)
  })
  it('rechnet mit dem sichtbaren Bereich eines abschneidenden Scroll-Containers', () => {
    const p = computePopoverPlacement({
      anchor: { top: 500, bottom: 520, left: 300 },
      width: 380,
      naturalHeight: 300,
      bounds: { top: 44, left: 248, right: 1100, bottom: 600 }
    })
    expect(p.side).toBe('top')
    expect(p.maxHeight).toBe(500 - 44 - 12)
  })
})
