import { useEffect, useState } from 'react'
import type { ModelCatalogEntry, ModelGroup } from '../../../../shared/validation/model-catalog-schemas'
import type { ModelDownloadStatus } from '../../../../shared/types/IpcApi'
import { useToast } from '../../hooks/useToast'
import { ConfirmDialog } from '../ConfirmDialog'
import { formatBytes } from '../../utils/formatBytes'
import ModelCard from './ModelCard'
import DiarizationPipelineSection from './DiarizationPipelineSection'

interface SectionConfig {
  group: ModelGroup
  title: string
  description: string
  activeUsageLabel: string
  activatedToast: (label: string) => string
}

const SECTIONS: SectionConfig[] = [
  {
    group: 'asr',
    title: 'Transkriptions-Modelle',
    description:
      'Wähle das Modell, das für die Transkription deiner Sitzungen verwendet werden soll. Ein Modellwechsel wirkt sich nur auf neue Transkriptionen aus.',
    activeUsageLabel: 'Wird für Transkription verwendet',
    activatedToast: (label) =>
      `"${label}" aktiviert. Neue Transkriptionen verwenden ab jetzt dieses Modell — bereits verarbeitete Sitzungen bleiben unverändert.`
  },
  {
    group: 'ner',
    title: 'Anonymisierungs-Modelle',
    description:
      'Wähle das Modell für die Erkennung personenbezogener Daten (Namen, Orte, Diagnosen). Die Modelle unterscheiden sich in Größe, Geschwindigkeit und welche Entity-Typen sie erkennen. Ein Wechsel wirkt sich nur auf neue Anonymisierungen aus.',
    activeUsageLabel: 'Wird für Anonymisierung verwendet',
    activatedToast: (label) =>
      `"${label}" aktiviert. Neue Anonymisierungen verwenden ab jetzt dieses Modell — bereits verarbeitete Sitzungen bleiben unverändert.`
  }
]

export default function ModelsSettings(): React.JSX.Element {
  const toast = useToast()
  const [modelsByGroup, setModelsByGroup] = useState<Record<ModelGroup, ModelCatalogEntry[]>>({
    asr: [],
    diarization: [],
    ner: []
  })
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [progress, setProgress] = useState<number | undefined>(undefined)
  const [deleteCandidate, setDeleteCandidate] = useState<ModelCatalogEntry | null>(null)

  const reload = async (): Promise<void> => {
    const groups: ModelGroup[] = SECTIONS.map((s) => s.group)
    const lists = await Promise.all(groups.map((g) => window.api.modelCatalog.list(g)))
    setModelsByGroup((prev) => {
      const next = { ...prev }
      groups.forEach((g, i) => {
        next[g] = lists[i]
      })
      return next
    })
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
      toast.success(`"${model.label}" gelöscht — ${formatBytes(model.sizeBytes)} freigegeben.`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleActivate = async (
    model: ModelCatalogEntry,
    section: SectionConfig
  ): Promise<void> => {
    try {
      await window.api.modelCatalog.setActive(model.group, model.id)
      await reload()
      toast.success(section.activatedToast(model.label))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const anyBusy = downloadingId !== null

  const renderSection = (section: SectionConfig): React.JSX.Element => {
    const models = modelsByGroup[section.group]
    const installed = models.filter((m) => m.isInstalled)
    const available = models.filter((m) => !m.isInstalled)

    return (
      <section key={section.group} className="space-y-3">
        <div>
          <h2 className="mb-1 text-lg font-semibold">{section.title}</h2>
          <p className="text-sm text-text-secondary">{section.description}</p>
        </div>

        {installed.length > 0 && (
          <div>
            <h3 className="mb-2 text-sm font-medium text-text-tertiary">Installiert</h3>
            <div className="space-y-3">
              {installed.map((m) => (
                <ModelCard
                  key={m.id}
                  model={m}
                  activeUsageLabel={section.activeUsageLabel}
                  downloading={downloadingId === m.id}
                  progress={downloadingId === m.id ? progress : undefined}
                  anyBusy={anyBusy}
                  deletable={!m.isRequired}
                  onDownload={() => handleDownload(m.id)}
                  onCancelDownload={handleCancelDownload}
                  onDelete={() => setDeleteCandidate(m)}
                  onActivate={() => handleActivate(m, section)}
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
                  activeUsageLabel={section.activeUsageLabel}
                  downloading={downloadingId === m.id}
                  progress={downloadingId === m.id ? progress : undefined}
                  anyBusy={anyBusy}
                  deletable={!m.isRequired}
                  onDownload={() => handleDownload(m.id)}
                  onCancelDownload={handleCancelDownload}
                  onDelete={() => setDeleteCandidate(m)}
                  onActivate={() => handleActivate(m, section)}
                />
              ))}
            </div>
          </div>
        )}
      </section>
    )
  }

  return (
    <div className="space-y-8 p-6">
      {renderSection(SECTIONS[0])}

      <DiarizationPipelineSection />

      {renderSection(SECTIONS[1])}

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
