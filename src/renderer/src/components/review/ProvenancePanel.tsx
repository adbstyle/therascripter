import { ChevronDown } from 'lucide-react'
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
 * Issue #84 Story I — Modell-Provenienz pro Sitzung. Default-collapsed
 * disclosure showing which model identity (id + version + sha256 + size)
 * produced each pipeline group's output. Uses native `<details>` so the
 * default-closed state and a11y come for free.
 *
 * Legacy sessions (processed_with_models == null) render the neutral hint
 * instead of fake/missing model rows.
 */
export function ProvenancePanel({ data, reviewAt }: Props): React.JSX.Element {
  const processedAt = formatProcessedAt(reviewAt)

  return (
    <details className="group rounded-lg border border-border bg-surface-1">
      <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-2.5 text-sm font-medium text-text-secondary hover:bg-surface-2">
        <span>Verarbeitungs-Information</span>
        <ChevronDown
          className="h-4 w-4 transition-transform group-open:rotate-180"
          strokeWidth={2}
          aria-hidden="true"
        />
      </summary>

      <div className="border-t border-border px-4 py-3 text-sm">
        {data === null ? (
          <p className="text-text-tertiary">{LEGACY_HINT}</p>
        ) : (
          <div className="space-y-3">
            {processedAt && (
              <Row label="Verarbeitet am" value={processedAt} />
            )}
            <div className="space-y-2">
              {GROUP_ORDER.map((group) => (
                <GroupRow
                  key={group}
                  label={GROUP_LABELS[group]}
                  snapshot={data[group]}
                />
              ))}
            </div>

            <details className="pt-1 text-xs">
              <summary className="cursor-pointer list-none text-text-tertiary hover:text-text-secondary">
                ▸ Technische Details (Hash, IDs)
              </summary>
              <div className="mt-2 space-y-2 rounded-md border border-border bg-surface-0 px-3 py-2 font-mono text-[11px] leading-relaxed text-text-tertiary">
                {GROUP_ORDER.map((group) => {
                  const snap = data[group]
                  if (!snap) return null
                  return (
                    <div key={group}>
                      <div className="text-text-secondary">{GROUP_LABELS[group]}</div>
                      <div>id: {snap.id}</div>
                      <div className="break-all">sha256: {snap.sha256}</div>
                    </div>
                  )
                })}
              </div>
            </details>
          </div>
        )}
      </div>
    </details>
  )
}

function Row({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex items-baseline gap-3">
      <span className="w-44 shrink-0 text-text-tertiary">{label}</span>
      <span className="text-text-primary">{value}</span>
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
    <div className="flex items-baseline gap-3">
      <span className="w-44 shrink-0 text-text-tertiary">{label}</span>
      {snapshot === null ? (
        <span className="text-text-tertiary">nicht erstellt</span>
      ) : (
        <span className="min-w-0 flex-1 text-text-primary">
          {snapshot.label}
          <span className="ml-2 text-text-tertiary">
            Version {snapshot.version} · {formatBytes(snapshot.sizeBytes)}
          </span>
        </span>
      )}
    </div>
  )
}
