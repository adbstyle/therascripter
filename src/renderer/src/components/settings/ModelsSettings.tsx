import { useEffect, useState } from 'react'
import type { ModelCatalogEntry } from '../../../../shared/validation/model-catalog-schemas'
import type { ModelDownloadStatus } from '../../../../shared/types/IpcApi'
import { useToast } from '../../hooks/useToast'
import { ConfirmDialog } from '../ConfirmDialog'
import { formatBytes } from '../../utils/formatBytes'
import ModelCard from './ModelCard'
import DiarizationPipelineSection from './DiarizationPipelineSection'

export default function ModelsSettings(): React.JSX.Element {
  const toast = useToast()
  const [asrModels, setAsrModels] = useState<ModelCatalogEntry[]>([])
  const [summarizationModels, setSummarizationModels] = useState<ModelCatalogEntry[]>([])
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [progress, setProgress] = useState<number | undefined>(undefined)
  const [deleteCandidate, setDeleteCandidate] = useState<ModelCatalogEntry | null>(null)

  const reload = async (): Promise<void> => {
    const [asr, summarization] = await Promise.all([
      window.api.modelCatalog.list('asr'),
      window.api.modelCatalog.list('summarization')
    ])
    setAsrModels(asr)
    setSummarizationModels(summarization)
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
      await window.api.modelCatalog.download(id)
      // download returns the catalog for the model's group only — reload both
      // to keep ASR + summarization grids in sync regardless of which one
      // triggered the download.
      await reload()
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
      await window.api.modelCatalog.delete(model.id)
      await reload()
      toast.success(
        `"${model.label}" gelöscht — ${formatBytes(model.sizeBytes)} freigegeben.`
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleActivate = async (model: ModelCatalogEntry): Promise<void> => {
    try {
      await window.api.modelCatalog.setActive(model.group, model.id)
      await reload()
      toast.success(
        `"${model.label}" aktiviert. Neue Transkriptionen verwenden ab jetzt dieses Modell — bereits verarbeitete Sitzungen bleiben unverändert.`
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const installed = asrModels.filter((m) => m.isInstalled)
  const available = asrModels.filter((m) => !m.isInstalled)
  const anyBusy = downloadingId !== null

  return (
    <div className="space-y-8 p-6">
      <section className="space-y-3">
        <div>
          <h2 className="mb-1 text-lg font-semibold">Transkriptions-Modelle</h2>
          <p className="text-sm text-text-secondary">
            Wähle das Modell, das für die Transkription deiner Sitzungen verwendet
            werden soll. Ein Modellwechsel wirkt sich nur auf neue Transkriptionen aus.
          </p>
        </div>

        {installed.length > 0 && (
          <div>
            <h3 className="mb-2 text-sm font-medium text-text-tertiary">Installiert</h3>
            <div className="space-y-3">
              {installed.map((m) => (
                <ModelCard
                  key={m.id}
                  model={m}
                  activeUsageLabel="Wird für Transkription verwendet"
                  downloading={downloadingId === m.id}
                  progress={downloadingId === m.id ? progress : undefined}
                  anyBusy={anyBusy}
                  onDownload={() => handleDownload(m.id)}
                  onCancelDownload={handleCancelDownload}
                  onDelete={() => setDeleteCandidate(m)}
                  onActivate={() => handleActivate(m)}
                />
              ))}
            </div>
          </div>
        )}

        {available.length > 0 && (
          <div>
            <h3 className="mb-2 text-sm font-medium text-text-tertiary">
              Zum Download verfügbar
            </h3>
            <div className="space-y-3">
              {available.map((m) => (
                <ModelCard
                  key={m.id}
                  model={m}
                  activeUsageLabel="Wird für Transkription verwendet"
                  downloading={downloadingId === m.id}
                  progress={downloadingId === m.id ? progress : undefined}
                  anyBusy={anyBusy}
                  onDownload={() => handleDownload(m.id)}
                  onCancelDownload={handleCancelDownload}
                  onDelete={() => setDeleteCandidate(m)}
                  onActivate={() => handleActivate(m)}
                />
              ))}
            </div>
          </div>
        )}
      </section>

      <DiarizationPipelineSection />

      <section className="space-y-3">
        <div>
          <h2 className="mb-1 text-lg font-semibold">Zusammenfassung (optional)</h2>
          <p className="text-sm text-text-secondary">
            Lokales Sprachmodell für 2-Satz-Zusammenfassungen am Ende der Verarbeitung.
            Optional — ohne installiertes Modell wird der Schritt geräuschlos
            übersprungen.
          </p>
        </div>

        <div className="space-y-3">
          {summarizationModels.map((m) => (
            <ModelCard
              key={m.id}
              model={m}
              activeUsageLabel="Wird für Zusammenfassungen verwendet"
              downloading={downloadingId === m.id}
              progress={downloadingId === m.id ? progress : undefined}
              anyBusy={anyBusy}
              onDownload={() => handleDownload(m.id)}
              onCancelDownload={handleCancelDownload}
              onDelete={() => setDeleteCandidate(m)}
              onActivate={() => handleActivate(m)}
            />
          ))}
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-medium text-text-tertiary">Pflicht-Modelle</h3>
        <p className="mb-2 text-xs text-text-tertiary">
          Diese Modelle sind für die Anonymisierung zwingend erforderlich und werden
          automatisch aktuell gehalten.
        </p>
        <ul className="space-y-1 rounded-md border border-border bg-surface-1 p-3 text-xs text-text-tertiary">
          <li>Sprechererkennung (pyannote-suite)</li>
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
