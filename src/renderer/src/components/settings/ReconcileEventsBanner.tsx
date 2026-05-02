import { Info } from 'lucide-react'
import type {
  ReconcileEvent,
  ReconcileReason
} from '../../../../shared/types/ReconcileEvent'
import type { ModelGroup } from '../../../../shared/validation/model-catalog-schemas'

interface Props {
  events: ReconcileEvent[]
  onDismiss: () => void
}

const GROUP_LABEL: Record<ModelGroup, string> = {
  asr: 'Spracherkennung',
  diarization: 'Sprechererkennung',
  ner: 'Pseudonymisierung',
  summarization: 'Zusammenfassung'
}

const REASON_LABEL: Record<ReconcileReason, string> = {
  'model-removed': 'Vorheriges Modell nicht mehr gefunden — kein Ersatz installiert',
  'default-promoted': 'Vorheriges Modell nicht mehr gefunden — Standard wurde aktiviert',
  'group-cleared': 'Vorheriges Modell nicht mehr gefunden — Schritt wird übersprungen'
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const date = d.toLocaleDateString('de-CH', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  })
  const time = d.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })
  return `${date} um ${time}`
}

/**
 * Issue #84 / Story C — surfaces invariant repairs the bootstrap reconciler
 * made (active model deleted from disk → promoted to default / cleared). The
 * BottomNav dot routed the user here; this banner explains *what* was changed
 * and lets them dismiss the notice. Persisted reconcile events are deleted
 * server-side when the user clicks "Verstanden".
 */
export default function ReconcileEventsBanner({ events, onDismiss }: Props): React.JSX.Element {
  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-lg border border-primary/30 bg-primary-light/20 p-4"
    >
      <div className="flex items-start gap-3">
        <Info
          className="mt-0.5 h-5 w-5 shrink-0 text-primary"
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-text-primary">Automatische Anpassung</h3>
          <p className="mt-1 text-sm text-text-secondary">
            Beim Start der App wurden Inkonsistenzen zwischen aktiver
            Modell-Auswahl und tatsächlich installierten Dateien gefunden und
            korrigiert.
          </p>

          <ul className="mt-3 space-y-2 text-sm">
            {events.map((e) => (
              <li
                key={e.id}
                className="rounded-md border border-border bg-surface-0 p-3"
              >
                <p className="font-medium text-text-primary">{GROUP_LABEL[e.group]}</p>
                <dl className="mt-1.5 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-text-secondary">
                  <dt>Bisher aktiv:</dt>
                  <dd>{e.fromModelId ?? '— (kein Modell)'}</dd>
                  <dt>Jetzt aktiv:</dt>
                  <dd>{e.toModelId ?? '— (kein Modell)'}</dd>
                  <dt>Grund:</dt>
                  <dd>{REASON_LABEL[e.reason]}</dd>
                  <dt>Geändert am:</dt>
                  <dd>{formatTimestamp(e.timestamp)}</dd>
                </dl>
              </li>
            ))}
          </ul>

          <p className="mt-3 text-sm text-text-secondary">
            Du kannst die Auswahl unten jederzeit anpassen.
          </p>

          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={onDismiss}
              className="titlebar-no-drag rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-primary-hover"
            >
              Verstanden
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
