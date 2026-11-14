import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { PageScroll } from '../../components/shell/PageScroll'
import { useScrollRestoration } from '../useScrollRestoration'

function Page({ ready }: { ready: boolean }): React.JSX.Element {
  useScrollRestoration(ready)
  return (
    <div>
      <div data-session-id="s1">Karte 1</div>
      <div data-session-id="s2">Karte 2</div>
    </div>
  )
}

function renderPage(options: {
  entryId?: number
  anchorId?: string
  positions?: Map<number, number>
  ready?: boolean
}) {
  const positions = options.positions ?? new Map<number, number>()
  const utils = render(
    <PageScroll entryId={options.entryId ?? 1} anchorId={options.anchorId} positions={positions}>
      <Page ready={options.ready ?? true} />
    </PageScroll>
  )
  return { ...utils, positions, container: utils.getByTestId('page-scroll') }
}

describe('useScrollRestoration', () => {
  it('merkt sich die Scroll-Position pro Verlaufseintrag', () => {
    const { container, positions } = renderPage({ entryId: 7 })
    container.scrollTop = 420
    container.dispatchEvent(new Event('scroll'))
    expect(positions.get(7)).toBe(420)
  })

  it('stellt die Position erst wieder her, wenn die Daten geladen sind', () => {
    const positions = new Map([[3, 250]])
    const { container, rerender } = renderPage({ entryId: 3, positions, ready: false })
    expect(container.scrollTop).toBe(0)

    rerender(
      <PageScroll entryId={3} anchorId={undefined} positions={positions}>
        <Page ready />
      </PageScroll>
    )
    expect(container.scrollTop).toBe(250)
  })

  it('hebt die Herkunftskarte hervor und holt sie nur ins Bild, wenn sie verdeckt ist', () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView

    // Sichtbar: nur Hervorhebung, kein Sprung
    const visible = renderPage({ anchorId: 's2' })
    const card = visible.getByText('Karte 2')
    expect(card.classList.contains('session-highlight')).toBe(true)
    expect(scrollIntoView).not.toHaveBeenCalled()
    visible.unmount()

    // Verdeckt (unterhalb des Containers): Sprung in die Mitte
    const original = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const top = (this as HTMLElement).dataset?.sessionId === 's2' ? 900 : 0
      return {
        top,
        bottom: top + (top ? 60 : 500),
        left: 0,
        right: 0,
        width: 0,
        height: 0
      } as DOMRect
    }
    try {
      const hidden = renderPage({ anchorId: 's2' })
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'instant' })
      expect(hidden.getByText('Karte 2').classList.contains('session-highlight')).toBe(true)
    } finally {
      Element.prototype.getBoundingClientRect = original
    }
  })

  it('räumt die Hervorhebung nach der Animation', () => {
    const { getByText } = renderPage({ anchorId: 's1' })
    const card = getByText('Karte 1')
    card.dispatchEvent(new Event('animationend'))
    expect(card.classList.contains('session-highlight')).toBe(false)
  })
})
