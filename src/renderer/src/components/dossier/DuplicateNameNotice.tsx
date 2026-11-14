import { Info } from 'lucide-react'
import type { DossierRef } from '../../../../shared/types/Dossier'
import { duplicateNameText } from '../../utils/dossierFormat'

interface DuplicateNameNoticeProps {
  duplicates: DossierRef[]
  /** Satz danach, z. B. «Sie können trotzdem ein weiteres anlegen.» */
  followUp: string
}

/** Hinweis auf gleiche Vor- und Nachnamen (#204 AK 6) — warnt, blockiert nie. */
export function DuplicateNameNotice({
  duplicates,
  followUp
}: DuplicateNameNoticeProps): React.JSX.Element {
  // Die Live-Region steht immer im DOM; nur ihr Inhalt kommt und geht —
  // sonst sagen Screenreader den Hinweis nicht zuverlässig an. Leer liegt sie
  // ausserhalb des Flusses (sr-only), damit sie keinen Abstand erzeugt.
  return (
    <div role="status" className={duplicates.length > 0 ? undefined : 'sr-only'}>
      {duplicates.length > 0 && (
        <div className="flex gap-2 rounded-lg border border-warning-border bg-warning-bg px-3 py-2 text-xs leading-[18px] text-warning-text">
          <Info className="mt-px h-4 w-4 shrink-0" strokeWidth={2} aria-hidden />
          <p>
            {duplicateNameText(duplicates)} {followUp}
          </p>
        </div>
      )}
    </div>
  )
}
