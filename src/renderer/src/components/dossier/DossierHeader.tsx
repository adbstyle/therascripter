import type { ReactNode } from 'react'
import type { DossierRef } from '../../../../shared/types/Dossier'
import { formatSwissDate } from '../../../../shared/utils/calendar-date'
import { dossierDisplayName, entryCountLabel } from '../../utils/dossierFormat'

interface DossierHeaderProps {
  dossier: DossierRef
  /** Anzahl zugeordneter Einträge; null, solange sie nicht geladen ist. */
  entryCount: number | null
  /** Aktionen rechts (`DossierHeaderActions`). */
  actions: ReactNode
}

/**
 * Kopf der Dossier-Seite: «Lukas Hofer», darunter
 * «PD-1188 · geboren 03.02.1978 · 9 Einträge». Zeigt den gespeicherten Stand;
 * ein noch nicht gespeicherter Entwurf steht nur im Formular.
 */
export function DossierHeader({
  dossier,
  entryCount,
  actions
}: DossierHeaderProps): React.JSX.Element {
  const subline = [
    dossier.externalId,
    dossier.birthDate ? `geboren ${formatSwissDate(dossier.birthDate)}` : null,
    entryCount === null ? null : entryCountLabel(entryCount)
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h1 className="break-words text-[22px] font-semibold leading-7 text-text-primary">
          {dossierDisplayName(dossier)}
        </h1>
        {subline && <span className="text-xs text-text-secondary">{subline}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2">{actions}</div>
    </header>
  )
}
