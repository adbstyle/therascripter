import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { PageScrollContext, type PageScrollInfo } from '../../navigation/useScrollRestoration'

interface PageScrollProps {
  entryId: number
  anchorId: string | undefined
  /** Scroll-Positionen aller Verlaufseinträge; lebt ausserhalb, weil PageScroll pro Eintrag neu gemountet wird. */
  positions: Map<number, number>
  children: ReactNode
}

/**
 * Der einzige Scroll-Container der Shell (Epic #192). Merkt sich die Position
 * je Verlaufseintrag, damit ‹ und Esc an dieselbe Stelle zurückführen.
 * Seiten mit eigenem Scrollbereich (Editor) füllen ihn über die
 * `min-h-0`-Flex-Kette und scrollen intern.
 */
export function PageScroll({
  entryId,
  anchorId,
  positions,
  children
}: PageScrollProps): React.JSX.Element {
  // State statt Ref: die Seite stellt ihre Position im Layout-Effekt her, der
  // vor dem Anhängen der Eltern-Ref läuft — mit dem Element im State läuft er
  // noch vor dem ersten Zeichnen ein zweites Mal, jetzt mit Container.
  const [element, setElement] = useState<HTMLElement | null>(null)
  const info = useMemo<PageScrollInfo>(
    () => ({ entryId, anchorId, element, positions }),
    [entryId, anchorId, element, positions]
  )

  return (
    <PageScrollContext.Provider value={info}>
      <main
        ref={setElement}
        data-testid="page-scroll"
        onScroll={(e) => positions.set(entryId, e.currentTarget.scrollTop)}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      >
        {children}
      </main>
    </PageScrollContext.Provider>
  )
}
