import { useEffect, useState } from 'react'
import type { ModelCatalogEntry } from '../../../../shared/validation/model-catalog-schemas'
import type { ModelDownloadStatus } from '../../../../shared/types/IpcApi'
import { useReconcileEvents } from '../../hooks/useReconcileEvents'
import { useToast } from '../../hooks/useToast'
import { ConfirmDialog } from '../ConfirmDialog'
import { formatBytes } from '../../utils/formatBytes'
import ModelCard from './ModelCard'
import DiarizationPipelineSection from './DiarizationPipelineSection'
import ReconcileEventsBanner from './ReconcileEventsBanner'

interface ModelsSettingsProps {
  /** Issue #84 / Story H — open the About sub-page so the user can read the
   *  Pseudonymisierung explainer. Triggered by the "Was ist Pseudonymisierung?"
   *  link below the group header. */
  onOpenAbout: () => void
}

export default function ModelsSettings({ onOpenAbout }: ModelsSettingsProps): React.JSX.Element {
  const toast = useToast()
  const reconcile = useReconcileEvents()
  const [asrModels, setAsrModels] = useState<ModelCatalogEntry[]>([])
  const [nerModels, setNerModels] = useState<ModelCatalogEntry[]>([])
  const [summarizationModels, setSummarizationModels] = useState<ModelCatalogEntry[]>([])
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [progress, setProgress] = useState<number | undefined>(undefined)
  const [deleteCandidate, setDeleteCandidate] = useState<ModelCatalogEntry | null>(null)

  // Mark reconcile events as seen on mount — the banner stays visible until
  // the user clicks "Verstanden", but the BottomNav dot disappears immediately
  // because the user has now reached the surface that explains the change.
  // Dep is the events array (changes when the hook refreshes) + the stable
  // markSeen callback. The `.some` guard short-circuits subsequent runs once
  // every event has transitioned to `seen`.
  const reconcileEvents = reconcile.events
  const reconcileMarkSeen = reconcile.markSeen
  useEffect(() => {
    if (reconcileEvents.some((e) => e.status === 'pending')) {
      reconcileMarkSeen()
    }
  }, [reconcileEvents, reconcileMarkSeen])

  const reload = async (): Promise<void> => {
    const [asr, ner, summarization] = await Promise.all([
      window.api.modelCatalog.list('asr'),
      window.api.modelCatalog.list('ner'),
      window.api.modelCatalog.list('summarization')
    ])
    setAsrModels(asr)
    setNerModels(ner)
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
        `"${model.label}" aktiviert. Neue Transkriptionen verwenden ab jetzt dieses Modell — bereits verarbeitete Transkriptionen bleiben unverändert.`
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleDeactivate = async (model: ModelCatalogEntry): Promise<void> => {
    try {
      await window.api.modelCatalog.clearActive(model.group)
      await reload()
      toast.success(
        `"${model.label}" deaktiviert. Zukünftige Transkriptionen werden ohne diesen Schritt verarbeitet.`
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
      {reconcile.events.length > 0 && (
        <ReconcileEventsBanner events={reconcile.events} onDismiss={reconcile.dismiss} />
      )}

      <section className="space-y-3">
        <div>
          <h2 className="mb-1 text-lg font-semibold">Transkriptions-Modelle</h2>
          <p className="text-sm text-text-secondary">
            Wähle das Modell, das für die Transkription verwendet werden soll. Ein
            Modellwechsel wirkt sich nur auf neue Transkriptionen aus.
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
          <h2 className="mb-1 text-lg font-semibold">Pseudonymisierung</h2>
          <p className="text-sm text-text-secondary">
            Erkennt Personen, Orte und andere sensible Entitäten.{' '}
            <button
              type="button"
              className="titlebar-no-drag font-medium text-primary transition-colors hover:text-primary-hover"
              onClick={onOpenAbout}
            >
              Was ist Pseudonymisierung? →
            </button>
          </p>
        </div>

        {nerModels.filter((m) => m.isInstalled).length > 0 && (
          <div>
            <h3 className="mb-2 text-sm font-medium text-text-tertiary">Installiert</h3>
            <div className="space-y-3">
              {nerModels
                .filter((m) => m.isInstalled)
                .map((m) => (
                  <ModelCard
                    key={m.id}
                    model={m}
                    downloading={downloadingId === m.id}
                    progress={downloadingId === m.id ? progress : undefined}
                    anyBusy={anyBusy}
                    deletable={false}
                    onDownload={() => handleDownload(m.id)}
                    onCancelDownload={handleCancelDownload}
                    onDelete={() => setDeleteCandidate(m)}
                    onActivate={() => handleActivate(m)}
                  />
                ))}
            </div>
          </div>
        )}

        {nerModels.filter((m) => !m.isInstalled).length > 0 && (
          <div>
            <h3 className="mb-2 text-sm font-medium text-text-tertiary">
              Zum Download verfügbar
            </h3>
            <div className="space-y-3">
              {nerModels
                .filter((m) => !m.isInstalled)
                .map((m) => (
                  <ModelCard
                    key={m.id}
                    model={m}
                    downloading={downloadingId === m.id}
                    progress={downloadingId === m.id ? progress : undefined}
                    anyBusy={anyBusy}
                    deletable={false}
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

      <section className="space-y-3">
        <div>
          <h2 className="mb-1 text-lg font-semibold">Zusammenfassung (optional)</h2>
          <p className="text-sm text-text-secondary">
            Lokales Sprachmodell für 2-Satz-Zusammenfassungen am Ende der Verarbeitung.
            Optional — ohne installiertes Modell wird der Schritt geräuschlos
            übersprungen.
          </p>
        </div>

        {summarizationModels.filter((m) => m.isInstalled).length > 0 && (
          <div>
            <h3 className="mb-2 text-sm font-medium text-text-tertiary">Installiert</h3>
            <div className="space-y-3">
              {summarizationModels
                .filter((m) => m.isInstalled)
                .map((m) => (
                  <ModelCard
                    key={m.id}
                    model={m}
                    downloading={downloadingId === m.id}
                    progress={downloadingId === m.id ? progress : undefined}
                    anyBusy={anyBusy}
                    optional
                    onDownload={() => handleDownload(m.id)}
                    onCancelDownload={handleCancelDownload}
                    onDelete={() => setDeleteCandidate(m)}
                    onActivate={() => handleActivate(m)}
                    onDeactivate={() => handleDeactivate(m)}
                  />
                ))}
            </div>
          </div>
        )}

        {summarizationModels.filter((m) => !m.isInstalled).length > 0 && (
          <div>
            <h3 className="mb-2 text-sm font-medium text-text-tertiary">
              Zum Download verfügbar
            </h3>
            <div className="space-y-3">
              {summarizationModels
                .filter((m) => !m.isInstalled)
                .map((m) => (
                  <ModelCard
                    key={m.id}
                    model={m}
                    downloading={downloadingId === m.id}
                    progress={downloadingId === m.id ? progress : undefined}
                    anyBusy={anyBusy}
                    optional
                    onDownload={() => handleDownload(m.id)}
                    onCancelDownload={handleCancelDownload}
                    onDelete={() => setDeleteCandidate(m)}
                    onActivate={() => handleActivate(m)}
                    onDeactivate={() => handleDeactivate(m)}
                  />
                ))}
            </div>
          </div>
        )}
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
