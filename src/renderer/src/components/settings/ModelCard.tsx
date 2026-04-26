import type { ModelCatalogEntry } from '../../../../shared/validation/model-catalog-schemas'
import { formatBytes } from '../../utils/formatBytes'

interface Props {
  model: ModelCatalogEntry
  downloading: boolean
  progress?: number
  anyBusy: boolean
  /** Anzeigetext unterhalb der Karte, wenn das Modell aktiv ist. */
  activeUsageLabel: string
  onDownload: () => void
  onCancelDownload: () => void
  onDelete: () => void
  onActivate: () => void
  /** Wird aufgerufen, wenn ein aktives optionales Modell deaktiviert werden soll. */
  onDeactivate?: () => void
  /** Löschen-Button anzeigen? Default true. Für gekoppelte Pipelines auf false setzen. */
  deletable?: boolean
  /** Optional-Gruppe (z. B. Zusammenfassung): Aktives Modell darf deaktiviert/gelöscht werden. */
  optional?: boolean
  /** Sprach- und Grössen-Chips anzeigen? Default true. */
  showChips?: boolean
}

/** Zeigt '—' für unbekannte Grössen (Platzhalter-Modelle vor R2-Upload). */
function formatModelSize(bytes: number): string {
  if (bytes === 0) return '—'
  return formatBytes(bytes)
}

function formatLanguage(code: string): string {
  switch (code) {
    case 'multi':
      return 'Multilingual'
    case 'de':
      return 'Hochdeutsch'
    case 'de-CH':
      return 'Schweizerdeutsch'
    default:
      return code
  }
}

function Chip({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-text-tertiary">
      {children}
    </span>
  )
}

export default function ModelCard({
  model,
  downloading,
  progress,
  anyBusy,
  activeUsageLabel,
  onDownload,
  onCancelDownload,
  onDelete,
  onActivate,
  onDeactivate,
  deletable = true,
  optional = false,
  showChips = true
}: Props): React.JSX.Element {
  const dimmed = downloading ? 'opacity-70' : ''
  const borderClass = model.isActive ? 'border-primary' : 'border-border'

  return (
    <div
      className={`rounded-lg border p-4 ${borderClass} ${dimmed}`}
      role="group"
      aria-labelledby={`model-${model.id}-name`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 id={`model-${model.id}-name`} className="font-semibold text-text-primary">
              {model.label}
            </h3>
            {model.isActive && (
              <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-white">
                Aktiv
              </span>
            )}
          </div>

          {showChips && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {model.languages?.map((lang) => <Chip key={lang}>{formatLanguage(lang)}</Chip>)}
              <Chip>{formatModelSize(model.sizeBytes)}</Chip>
            </div>
          )}

          {model.description && (
            <p className="mt-2 text-sm leading-relaxed text-text-secondary">
              {model.description}
            </p>
          )}
        </div>
      </div>

      {downloading && progress !== undefined && (
        <div className="mt-3">
          <div
            className="h-1 w-full overflow-hidden rounded-full bg-surface-2"
            role="progressbar"
            aria-valuenow={progress}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="mt-1 text-xs text-text-tertiary">Lädt herunter … {progress}%</p>
        </div>
      )}

      <div className="mt-3 flex justify-end gap-2">
        {downloading && (
          <button
            className="titlebar-no-drag rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary hover:bg-surface-2"
            onClick={onCancelDownload}
          >
            Download abbrechen
          </button>
        )}
        {!downloading && !model.isInstalled && (
          <button
            className="titlebar-no-drag rounded-md bg-primary px-3 py-1.5 text-sm text-white hover:bg-primary-hover disabled:opacity-50"
            onClick={onDownload}
            disabled={anyBusy}
          >
            Herunterladen
          </button>
        )}
        {!downloading && model.isInstalled && !model.isActive && (
          <>
            {deletable && (
              <button
                className="titlebar-no-drag rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary hover:bg-surface-2 disabled:opacity-50"
                onClick={onDelete}
                disabled={anyBusy}
              >
                Löschen
              </button>
            )}
            <button
              className="titlebar-no-drag rounded-md bg-primary px-3 py-1.5 text-sm text-white hover:bg-primary-hover disabled:opacity-50"
              onClick={onActivate}
              disabled={anyBusy}
            >
              Aktivieren
            </button>
          </>
        )}
        {!downloading && model.isInstalled && model.isActive && !optional && (
          <span className="text-xs text-text-tertiary">{activeUsageLabel}</span>
        )}
        {!downloading && model.isInstalled && model.isActive && optional && (
          <>
            <span className="mr-auto self-center text-xs text-text-tertiary">
              {activeUsageLabel}
            </span>
            {deletable && (
              <button
                className="titlebar-no-drag rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary hover:bg-surface-2 disabled:opacity-50"
                onClick={onDelete}
                disabled={anyBusy}
              >
                Löschen
              </button>
            )}
            {onDeactivate && (
              <button
                className="titlebar-no-drag rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary hover:bg-surface-2 disabled:opacity-50"
                onClick={onDeactivate}
                disabled={anyBusy}
              >
                Deaktivieren
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
