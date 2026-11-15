import { ArrowDownWideNarrow, Info } from 'lucide-react'

/**
 * Kopf der Trefferliste: in der pseudonymisierten Ansicht deutlich, dass die
 * Ausschnitte Klarnamen zeigen und sich dort nicht kopieren lassen; nach
 * nachgekommenen Treffern «Nach Relevanz sortieren».
 */
export function ResultsHead({
  plain,
  reordered,
  onSortByRelevance
}: {
  plain: boolean
  reordered: boolean
  onSortByRelevance: () => void
}): React.JSX.Element | null {
  if (plain && !reordered) return null
  return (
    <div className="flex flex-col gap-2 px-0.5 pb-1 pt-2">
      {!plain && (
        <div
          role="note"
          aria-label="Ausschnitte im Klartext"
          className="flex gap-2 rounded-lg border border-warning-border bg-warning-bg px-3 py-2 text-xs text-warning-text"
        >
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={2} aria-hidden />
          <span>
            <strong className="font-semibold">Ausschnitte im Klartext:</strong> Die Treffer zeigen
            Klarnamen, auch in der pseudonymisierten Ansicht. Auswählen und kopieren lassen sie sich
            nur in der Klartext-Ansicht.
          </span>
        </div>
      )}
      {reordered && (
        <button
          type="button"
          onClick={onSortByRelevance}
          className="inline-flex items-center gap-1.5 self-start rounded-md px-2 py-1 text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <ArrowDownWideNarrow className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
          Neue Treffer nach Bedeutung — nach Relevanz sortieren
        </button>
      )}
    </div>
  )
}
