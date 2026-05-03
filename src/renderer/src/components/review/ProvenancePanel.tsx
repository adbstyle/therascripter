import { formatBytes } from '../../utils/formatBytes'
import type { ModelSnapshot, ProcessedModelsSnapshot } from '../../../../shared/types'

interface Props {
  data: ProcessedModelsSnapshot | null
  reviewAt: string | null
}

type GroupKey = 'asr' | 'diarization' | 'ner' | 'summarization'

const GROUP_LABELS: Record<GroupKey, string> = {
  asr: 'Spracherkennung',
  diarization: 'Sprechererkennung',
  ner: 'Pseudonymisierung',
  summarization: 'Zusammenfassung'
}

const GROUP_ORDER: GroupKey[] = ['asr', 'diarization', 'ner', 'summarization']

const LEGACY_HINT =
  'Diese Sitzung wurde vor Einführung der detaillierten Modell-Protokollierung verarbeitet.'

function formatProcessedAt(iso: string | null): string | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleString('de-CH', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/**
 * Verarbeitungs-Information — content-only side-panel tab body. Stacked
 * label/value rows because the 300px panel cannot accommodate the
 * two-column layout used in the editor area before issue #86. Each model
 * shows label, version + size, id, and sha256 inline.
 *
 * Legacy sessions (processed_with_models == null) render the neutral
 * hint instead of model rows.
 */
export function ProvenancePanel({ data, reviewAt }: Props): React.JSX.Element {
  const processedAt = formatProcessedAt(reviewAt)

  if (data === null) {
    return <p className="px-4 py-3 text-sm text-text-tertiary">{LEGACY_HINT}</p>
  }

  return (
    <div className="space-y-4 px-4 py-3 text-sm">
      {processedAt && <Row label="Verarbeitet am" value={processedAt} />}
      <div className="space-y-3">
        {GROUP_ORDER.map((group) => (
          <GroupRow key={group} label={GROUP_LABELS[group]} snapshot={data[group]} />
        ))}
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div>
      <div className="text-xs text-text-tertiary">{label}</div>
      <div className="text-text-primary">{value}</div>
    </div>
  )
}

function GroupRow({
  label,
  snapshot
}: {
  label: string
  snapshot: ModelSnapshot | null
}): React.JSX.Element {
  return (
    <div>
      <div className="text-xs text-text-tertiary">{label}</div>
      {snapshot === null ? (
        <div className="text-text-tertiary">nicht erstellt</div>
      ) : (
        <>
          <div className="text-text-primary">
            <span className="break-words">{snapshot.label}</span>
            <div className="text-xs text-text-tertiary">
              Version {snapshot.version} · {formatBytes(snapshot.sizeBytes)}
            </div>
            <div className="text-xs text-text-tertiary">
              <div className="break-all">id: {snapshot.id}</div>
              <div className="break-all">sha256: {snapshot.sha256}</div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
