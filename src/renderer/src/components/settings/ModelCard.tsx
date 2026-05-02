import { Download, ExternalLink, Power, PowerOff, Trash2, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ModelCatalogEntry } from '../../../../shared/validation/model-catalog-schemas'
import { formatBytes } from '../../utils/formatBytes'
import ModelStatusBadge, { deriveModelStatus } from './ModelStatusBadge'

interface Props {
  model: ModelCatalogEntry
  downloading: boolean
  progress?: number
  anyBusy: boolean
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

  type IconAction = {
    id: string
    Icon: LucideIcon
    label: string
    handler: () => void
    disabled?: boolean
    tone?: 'danger'
  }

  // Primary action — also fires on card click via stretched button.
  let primaryAction: IconAction | null = null
  if (!downloading && !model.isInstalled) {
    primaryAction = {
      id: 'download',
      Icon: Download,
      label: 'Herunterladen',
      handler: onDownload,
      disabled: anyBusy
    }
  } else if (!downloading && model.isInstalled && !model.isActive) {
    primaryAction = {
      id: 'activate',
      Icon: Power,
      label: 'Aktivieren',
      handler: onActivate,
      disabled: anyBusy
    }
  }

  // Secondary actions — destructive / non-primary alternatives.
  const secondaryActions: IconAction[] = []
  if (downloading) {
    secondaryActions.push({
      id: 'cancel',
      Icon: X,
      label: 'Download abbrechen',
      handler: onCancelDownload
    })
  } else if (model.isInstalled && !model.isActive && deletable) {
    secondaryActions.push({
      id: 'delete',
      Icon: Trash2,
      label: 'Löschen',
      handler: onDelete,
      disabled: anyBusy,
      tone: 'danger'
    })
  } else if (model.isInstalled && model.isActive && optional) {
    if (onDeactivate) {
      secondaryActions.push({
        id: 'deactivate',
        Icon: PowerOff,
        label: 'Deaktivieren',
        handler: onDeactivate,
        disabled: anyBusy
      })
    }
    if (deletable) {
      secondaryActions.push({
        id: 'delete',
        Icon: Trash2,
        label: 'Löschen',
        handler: onDelete,
        disabled: anyBusy,
        tone: 'danger'
      })
    }
  }

  // Icons rendered on hover, top-right. Secondary first, primary last (rightmost).
  const iconActions: IconAction[] = [...secondaryActions, ...(primaryAction ? [primaryAction] : [])]

  return (
    <div
      className={`relative rounded-lg border p-4 ${borderClass} ${dimmed}`}
      role="group"
      aria-labelledby={`model-${model.id}-name`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 id={`model-${model.id}-name`} className="font-semibold text-text-primary">
              {model.label}
            </h3>
            {model.hfRepo && (
              <a
                href={`https://huggingface.co/${model.hfRepo}`}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`${model.label} auf HuggingFace ansehen`}
                title="Auf HuggingFace ansehen"
                className="titlebar-no-drag inline-flex h-5 w-5 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-surface-2 hover:text-text-primary"
              >
                <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
              </a>
            )}
            <ModelStatusBadge status={deriveModelStatus(model)} />
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

        {iconActions.length > 0 && (
          <div className="flex shrink-0 items-center gap-1">
            {iconActions.map((a) => {
              const dangerClass = 'hover:bg-error-bg hover:text-error-text'
              const neutralClass = 'hover:bg-surface-2 hover:text-text-primary'
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={a.handler}
                  disabled={a.disabled}
                  aria-label={a.label}
                  title={a.label}
                  className={`titlebar-no-drag rounded p-1.5 text-text-tertiary transition-colors disabled:opacity-50 ${
                    a.tone === 'danger' ? dangerClass : neutralClass
                  }`}
                >
                  <a.Icon className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                </button>
              )
            })}
          </div>
        )}
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
    </div>
  )
}
