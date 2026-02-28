import type { PendingModelUpdate } from '../../../shared/types/ModelUpdate'
import { formatBytes } from '../utils/formatBytes'

interface UpdateBannerProps {
  updates: PendingModelUpdate[]
  onRestart: () => void
}

export default function UpdateBanner({ updates, onRestart }: UpdateBannerProps): React.JSX.Element {
  const totalBytes = updates.reduce((sum, u) => sum + u.sizeBytes, 0)
  const count = updates.length

  return (
    <div className="flex items-center justify-between border-b border-info-border bg-info-bg px-6 py-2.5">
      <div className="flex items-center gap-2 text-sm text-info-text">
        <span>&#8635;</span>
        <span>
          Modell-Update verfügbar ({count} {count === 1 ? 'Modell' : 'Modelle'},{' '}
          ~{formatBytes(totalBytes)})
        </span>
      </div>
      <button
        className="titlebar-no-drag rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-primary-hover"
        onClick={onRestart}
      >
        Jetzt neu starten
      </button>
    </div>
  )
}
