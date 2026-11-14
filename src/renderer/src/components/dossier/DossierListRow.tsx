import { memo } from 'react'
import type { KeyboardEvent } from 'react'
import type { DossierListItem } from '../../../../shared/types/Dossier'
import {
  dossierIdentification,
  dossierListName,
  entryCountLabel,
  lastEntryLabel
} from '../../utils/dossierFormat'

interface DossierListRowProps {
  dossier: DossierListItem
  todayIso: string
  onOpen: (dossierId: string) => void
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void
}

/**
 * Zeile der Übersicht: «Nachname, Vorname», «ID · Geburtsdatum» zur
 * Unterscheidung gleichnamiger Personen, Anzahl Einträge, Tag des jüngsten
 * Eintrags. Bewusst ohne Diagnosen — die Liste ist auch bei geteiltem
 * Bildschirm unbedenklich.
 */
export const DossierListRow = memo(function DossierListRow({
  dossier,
  todayIso,
  onOpen,
  onKeyDown
}: DossierListRowProps): React.JSX.Element {
  const identification = dossierIdentification(dossier)
  return (
    <li className="border-t border-border">
      <button
        type="button"
        data-anchor-id={dossier.id}
        data-dossier-row=""
        onClick={() => onOpen(dossier.id)}
        onKeyDown={onKeyDown}
        className="grid w-full grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-4 rounded-md px-2 py-2.5 text-left transition-colors hover:bg-surface-1 focus-visible:bg-surface-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <span className="truncate text-sm font-medium text-text-primary">
          {dossierListName(dossier)}
        </span>
        <span className="truncate text-xs text-text-secondary">{identification}</span>
        <span className="truncate text-xs text-text-secondary">
          {entryCountLabel(dossier.entryCount)}
        </span>
        <span className="text-right text-xs text-text-secondary">
          {dossier.lastEntryDay ? (
            lastEntryLabel(dossier.lastEntryDay, todayIso)
          ) : (
            <span aria-label="Kein Eintrag">—</span>
          )}
        </span>
      </button>
    </li>
  )
})
