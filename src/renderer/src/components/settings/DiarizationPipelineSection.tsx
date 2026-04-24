import { useEffect, useState } from 'react'
import type { DiarizationPipeline } from '../../../../shared/validation/model-catalog-schemas'
import { useToast } from '../../hooks/useToast'

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

export default function DiarizationPipelineSection(): React.JSX.Element {
  const toast = useToast()
  const [active, setActive] = useState<DiarizationPipeline | null>(null)

  useEffect(() => {
    window.api.pipeline.getDiarization().then(setActive)
  }, [])

  const handleSelect = async (pipeline: DiarizationPipeline): Promise<void> => {
    if (pipeline === active) return
    try {
      await window.api.pipeline.setDiarization(pipeline)
      setActive(pipeline)
      toast.success(
        'Pipeline aktiviert. Neue Sitzungen verwenden ab jetzt diese Pipeline — bereits verarbeitete Sitzungen bleiben unverändert.'
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
          Das pyannote-Paket enthält zwei Pipelines. Wähle, welche für neue Sitzungen
          verwendet werden soll — kein Download nötig, der Wechsel ist sofort aktiv.
        </p>
      </div>

      <div className="space-y-2">
        {PIPELINE_INFOS.map((info) => {
          const isActive = active === info.id
          return (
            <button
              key={info.id}
              type="button"
              onClick={() => handleSelect(info.id)}
              className={`titlebar-no-drag w-full rounded-lg border p-4 text-left transition-colors ${
                isActive
                  ? 'border-primary bg-surface-1'
                  : 'border-border hover:bg-surface-2'
              }`}
              aria-pressed={isActive}
            >
              <div className="flex items-start gap-3">
                <div
                  className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                    isActive ? 'border-primary' : 'border-border'
                  }`}
                  aria-hidden
                >
                  {isActive && <div className="h-2 w-2 rounded-full bg-primary" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-text-primary">{info.label}</span>
                    {isActive && (
                      <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-white">
                        Aktiv
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-sm leading-relaxed text-text-secondary">
                    {info.description}
                  </p>
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </section>
  )
}
