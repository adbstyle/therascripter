import { useEffect, useState } from 'react'
import type {
  DiarizationPipeline,
  ModelCatalogEntry
} from '../../../../shared/validation/model-catalog-schemas'
import { useToast } from '../../hooks/useToast'
import ModelCard from './ModelCard'

interface PipelineInfo {
  id: DiarizationPipeline
  label: string
  description: string
}

const PIPELINE_INFOS: PipelineInfo[] = [
  {
    id: 'pyannote/speaker-diarization-3.1',
    label: 'Diarization 3.1',
    description:
      'Standard-Pipeline. Breit getestet, solide auf Hochdeutsch. Agglomerative Clustering.'
  },
  {
    id: 'pyannote/speaker-diarization-community-1',
    label: 'Diarization Community 1',
    description:
      'Community-Variante mit besserer Performance auf Deutsch (DER ca. 8.3 % laut HF). Experimentell. VBx Clustering.'
  }
]

/** Baut einen Pseudo-ModelCatalogEntry, damit die Pipeline im ModelCard gerendert werden kann. */
function toCatalogEntry(info: PipelineInfo, isActive: boolean): ModelCatalogEntry {
  return {
    id: info.id,
    label: info.label,
    description: info.description,
    sizeBytes: 0,
    group: 'diarization',
    isRequired: true,
    isInstalled: true,
    isActive
  }
}

const noop = (): void => {}

export default function DiarizationPipelineSection(): React.JSX.Element {
  const toast = useToast()
  const [active, setActive] = useState<DiarizationPipeline | null>(null)

  useEffect(() => {
    window.api.pipeline.getDiarization().then(setActive)
  }, [])

  const handleActivate = async (pipeline: DiarizationPipeline): Promise<void> => {
    if (pipeline === active) return
    try {
      await window.api.pipeline.setDiarization(pipeline)
      setActive(pipeline)
      toast.success(
        'Pipeline aktiviert. Neue Transkriptionen verwenden ab jetzt diese Pipeline — bereits verarbeitete Transkriptionen bleiben unverändert.'
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <section className="space-y-3">
      <div>
        <h2 className="mb-1 text-lg font-semibold">Sprechererkennungs-Pipeline</h2>
        <p className="text-sm text-text-secondary">
          Das pyannote-Paket enthält zwei Pipelines. Wähle, welche für neue Transkriptionen
          verwendet werden soll — kein Download nötig, der Wechsel ist sofort aktiv.
        </p>
      </div>

      <div className="space-y-3">
        {PIPELINE_INFOS.map((info) => (
          <ModelCard
            key={info.id}
            model={toCatalogEntry(info, active === info.id)}
            activeUsageLabel="Wird für Sprechererkennung verwendet"
            downloading={false}
            anyBusy={false}
            deletable={false}
            showChips={false}
            onDownload={noop}
            onCancelDownload={noop}
            onDelete={noop}
            onActivate={() => handleActivate(info.id)}
          />
        ))}
      </div>
    </section>
  )
}
