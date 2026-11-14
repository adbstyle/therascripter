import type { ReactNode } from 'react'

interface PageHeaderProps {
  /** Seitentitel; bei Brotkrümeln (Einstellungen) ein eigener Knoten. */
  title: ReactNode
  /** Aktionen rechts, brechen bei schmalem Fenster unter den Titel um. */
  actions?: ReactNode
}

/**
 * Seitenkopf innerhalb der Seite (Epic #192): scrollt mit dem Inhalt, kein
 * Zurück-Knopf — zurück geht es über ‹ in der Titelleiste, ⌘[ oder Esc.
 */
export function PageHeader({ title, actions }: PageHeaderProps): React.JSX.Element {
  return (
    <header className="flex flex-wrap items-center justify-between gap-3">
      {typeof title === 'string' ? (
        <h1 className="text-xl font-semibold leading-7 text-text-primary">{title}</h1>
      ) : (
        title
      )}
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  )
}

/** Zentrierter Inhaltsbereich einer Seite (max. 860 px, wie im Prototyp). */
export function PageContainer({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="mx-auto flex w-full max-w-[860px] flex-1 flex-col gap-4 p-6">{children}</div>
  )
}
