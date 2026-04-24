import { useEffect, useState } from 'react'
import type { ModelCatalogEntry } from '../../../../shared/validation/model-catalog-schemas'
import type { ModelDownloadStatus } from '../../../../shared/types/IpcApi'
import { useToast } from '../../hooks/useToast'
import { ConfirmDialog } from '../ConfirmDialog'
import { formatBytes } from '../../utils/formatBytes'
import ModelCard from './ModelCard'

type Group = 'asr' | 'diarization'

interface SectionProps {
  title: string
  description: string
  models: ModelCatalogEntry[]
  activeUsageLabel: string
  downloadingId: string | null
  progress: number | undefined
  anyBusy: boolean
  onDownload: (id: string) => void
  onCancelDownload: () => void
  onRequestDelete: (model: ModelCatalogEntry) => void
  onActivate: (model: ModelCatalogEntry) => void
}

function ModelSection({
  title,
  description,
  models,
  activeUsageLabel,
  downloadingId,
  progress,
  anyBusy,
  onDownload,
  onCancelDownload,
  onRequestDelete,
  onActivate
}: SectionProps): React.JSX.Element | null {
  const installed = models.filter((m) => m.isInstalled)
  const available = models.filter((m) => !m.isInstalled)

  return (
    <section className="space-y-3">
      <div>
        <h2 className="mb-1 text-lg font-semibold">{title}</h2>
        <p className="text-sm text-text-secondary">{description}</p>
      </div>

      {installed.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-medium text-text-tertiary">Installiert</h3>
          <div className="space-y-3">
            {installed.map((m) => (
              <ModelCard
                key={m.id}
                model={m}
                activeUsageLabel={activeUsageLabel}
                downloading={downloadingId === m.id}
                progress={downloadingId === m.id ? progress : undefined}
                anyBusy={anyBusy}
                onDownload={() => onDownload(m.id)}
                onCancelDownload={onCancelDownload}
                onDelete={() => onRequestDelete(m)}
                onActivate={() => onActivate(m)}
              />
            ))}
          </div>
        </div>
      )}

      {available.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-medium text-text-tertiary">Zum Download verfügbar</h3>
          <div className="space-y-3">
            {available.map((m) => (
              <ModelCard
                key={m.id}
                model={m}
                activeUsageLabel={activeUsageLabel}
                downloading={downloadingId === m.id}
                progress={downloadingId === m.id ? progress : undefined}
                anyBusy={anyBusy}
                onDownload={() => onDownload(m.id)}
                onCancelDownload={onCancelDownload}
                onDelete={() => onRequestDelete(m)}
                onActivate={() => onActivate(m)}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

export default function ModelsSettings(): React.JSX.Element {
  const toast = useToast()
  const [asrModels, setAsrModels] = useState<ModelCatalogEntry[]>([])
  const [diarModels, setDiarModels] = useState<ModelCatalogEntry[]>([])
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [progress, setProgress] = useState<number | undefined>(undefined)
  const [deleteCandidate, setDeleteCandidate] = useState<ModelCatalogEntry | null>(null)

  const reload = async (): Promise<void> => {
    const [asr, diar] = await Promise.all([
      window.api.modelCatalog.list('asr'),
      window.api.modelCatalog.list('diarization')
    ])
    setAsrModels(asr)
    setDiarModels(diar)
  }

  const storeForGroup = (group: Group, entries: ModelCatalogEntry[]): void => {
    if (group === 'asr') setAsrModels(entries)
    else setDiarModels(entries)
  }

  useEffect(() => {
    reload()
    const unsubscribe = window.api.modelDownload.onStatus((status: ModelDownloadStatus) => {
      if (status.state === 'downloading') {
        setProgress(status.progress.currentModelProgress)
      } else if (status.state === 'complete') {
        setProgress(undefined)
        setDownloadingId(null)
        reload()
      } else if (status.state === 'error') {
        toast.error(status.error)
        setProgress(undefined)
        setDownloadingId(null)
      }
    })
    return unsubscribe
  }, [toast])

  const handleDownload = async (id: string): Promise<void> => {
    setDownloadingId(id)
    try {
      const updated = await window.api.modelCatalog.download(id)
      const group = updated[0]?.group
      if (group === 'asr' || group === 'diarization') {
        storeForGroup(group, updated)
      } else {
        reload()
      }
      toast.success('Modell erfolgreich heruntergeladen.')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      setDownloadingId(null)
    }
  }

  const handleCancelDownload = async (): Promise<void> => {
    await window.api.modelCatalog.cancelDownload()
    setDownloadingId(null)
    setProgress(undefined)
  }

  const handleDeleteConfirmed = async (model: ModelCatalogEntry): Promise<void> => {
    setDeleteCandidate(null)
    try {
      const updated = await window.api.modelCatalog.delete(model.id)
      if (model.group === 'asr' || model.group === 'diarization') {
        storeForGroup(model.group, updated)
      }
      toast.success(
        `"${model.label}" gelöscht — ${formatBytes(model.sizeBytes)} freigegeben.`
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleActivate = async (model: ModelCatalogEntry): Promise<void> => {
    try {
      const updated = await window.api.modelCatalog.setActive(model.group, model.id)
      if (model.group === 'asr' || model.group === 'diarization') {
        storeForGroup(model.group, updated)
      }
      toast.success(
        `"${model.label}" aktiviert. Neue Verarbeitungen verwenden ab jetzt dieses Modell — bereits verarbeitete Sitzungen bleiben unverändert.`
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const anyBusy = downloadingId !== null

  return (
    <div className="space-y-8 p-6">
      <ModelSection
        title="Transkriptions-Modelle"
        description="Wähle das Modell, das für die Transkription deiner Sitzungen verwendet werden soll. Ein Modellwechsel wirkt sich nur auf neue Transkriptionen aus."
        models={asrModels}
        activeUsageLabel="Wird für Transkription verwendet"
        downloadingId={downloadingId}
        progress={progress}
        anyBusy={anyBusy}
        onDownload={handleDownload}
        onCancelDownload={handleCancelDownload}
        onRequestDelete={setDeleteCandidate}
        onActivate={handleActivate}
      />

      <ModelSection
        title="Sprechererkennungs-Modelle"
        description="Diarization-Modell zur Unterscheidung der Sprecher:innen. Ein Modellwechsel wirkt sich nur auf neue Sitzungen aus."
        models={diarModels}
        activeUsageLabel="Wird für Sprechererkennung verwendet"
        downloadingId={downloadingId}
        progress={progress}
        anyBusy={anyBusy}
        onDownload={handleDownload}
        onCancelDownload={handleCancelDownload}
        onRequestDelete={setDeleteCandidate}
        onActivate={handleActivate}
      />

      <section>
        <h3 className="mb-2 text-sm font-medium text-text-tertiary">Pflicht-Modelle</h3>
        <p className="mb-2 text-xs text-text-tertiary">
          Dieses Modell ist für die Anonymisierung zwingend erforderlich und wird
          automatisch aktuell gehalten.
        </p>
        <ul className="space-y-1 rounded-md border border-border bg-surface-1 p-3 text-xs text-text-tertiary">
          <li>Anonymisierung (flair-ner-german-large)</li>
        </ul>
      </section>

      {deleteCandidate && (
        <ConfirmDialog
          title={`${deleteCandidate.label} löschen?`}
          message={`${formatBytes(deleteCandidate.sizeBytes)} werden freigegeben. Du kannst das Modell später jederzeit erneut herunterladen.`}
          confirmLabel="Löschen"
          destructive
          onConfirm={() => handleDeleteConfirmed(deleteCandidate)}
          onCancel={() => setDeleteCandidate(null)}
        />
      )}
    </div>
  )
}
