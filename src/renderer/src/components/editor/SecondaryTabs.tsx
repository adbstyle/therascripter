import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'

export interface SecondaryTab<TId extends string> {
  id: TId
  label: string
  badge?: number | null
}

interface SecondaryTabsProps<TId extends string> {
  tabs: readonly SecondaryTab<TId>[]
  activeId: TId
  onChange: (id: TId) => void
  ariaLabel: string
  idPrefix: string
}

interface IndicatorRect {
  left: number
  width: number
}

/**
 * Material 3 Secondary Tabs primitive — WAI-ARIA tabs pattern with roving
 * tabindex and ArrowLeft/Right + Home/End navigation.
 *
 * Tabs are `flex-1` so a small fixed set (2-3 short labels) feels
 * balanced in the panel header, but content sets the minimum width
 * (no `min-w-0` / no truncate). When labels collectively exceed the
 * strip width, the strip becomes horizontally scrollable.
 *
 * The 2px primary-color indicator is positioned by measuring the active
 * tab's actual offset/width — so it tracks correctly for any number of
 * tabs and any label length.
 */
export function SecondaryTabs<TId extends string>({
  tabs,
  activeId,
  onChange,
  ariaLabel,
  idPrefix
}: SecondaryTabsProps<TId>): React.JSX.Element {
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  const tabCount = tabs.length
  const activeIndex = Math.max(
    0,
    tabs.findIndex((t) => t.id === activeId)
  )
  const [indicator, setIndicator] = useState<IndicatorRect>({ left: 0, width: 0 })

  useLayoutEffect(() => {
    const measure = (): void => {
      const el = tabRefs.current[activeIndex]
      if (!el) return
      setIndicator({ left: el.offsetLeft, width: el.offsetWidth })
    }

    measure()

    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    tabRefs.current.forEach((el) => {
      if (el) observer.observe(el)
    })
    return () => observer.disconnect()
  }, [activeIndex, tabCount])

  const focusAndActivate = (index: number): void => {
    const next = ((index % tabCount) + tabCount) % tabCount
    tabRefs.current[next]?.focus()
    onChange(tabs[next].id)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault()
        focusAndActivate(index + 1)
        break
      case 'ArrowLeft':
        e.preventDefault()
        focusAndActivate(index - 1)
        break
      case 'Home':
        e.preventDefault()
        focusAndActivate(0)
        break
      case 'End':
        e.preventDefault()
        focusAndActivate(tabCount - 1)
        break
    }
  }

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="relative flex h-12 shrink-0 items-stretch overflow-x-auto border-b border-border"
    >
      {tabs.map((tab, index) => {
        const isActive = tab.id === activeId
        return (
          <button
            key={tab.id}
            ref={(el) => {
              tabRefs.current[index] = el
            }}
            role="tab"
            type="button"
            id={`${idPrefix}-tab-${tab.id}`}
            aria-selected={isActive}
            aria-controls={`${idPrefix}-panel-${tab.id}`}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={(e) => handleKeyDown(e, index)}
            className={`relative flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap px-3 text-[13px] font-medium transition-colors focus-visible:bg-surface-2 focus-visible:outline-none ${
              isActive
                ? 'text-text-primary'
                : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary'
            }`}
          >
            <span>{tab.label}</span>
            {tab.badge != null && tab.badge > 0 && (
              <span className="shrink-0 rounded-full bg-surface-3 px-1.5 py-0.5 text-[11px] font-medium text-text-secondary">
                {tab.badge}
              </span>
            )}
          </button>
        )
      })}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute bottom-0 left-0 h-0.5 bg-primary transition-[transform,width] duration-[280ms] ease-[cubic-bezier(0.34,1.56,0.64,1)]"
        style={{
          width: `${indicator.width}px`,
          transform: `translateX(${indicator.left}px)`
        }}
      />
    </div>
  )
}
