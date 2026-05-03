import { X } from 'lucide-react'
import type { PendingModelUpdate } from '../../../shared/types/ModelUpdate'
import { formatBytes } from '../utils/formatBytes'

interface UpdateBannerProps {
  updates: PendingModelUpdate[]
  onRestart: () => void
  onDismiss: () => void
}

export default function UpdateBanner({
  updates,
  onRestart,
  onDismiss
}: UpdateBannerProps): React.JSX.Element {
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
      <div className="flex items-center gap-2">
        <button
          className="titlebar-no-drag rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-primary-hover"
          onClick={onRestart}
        >
          Jetzt neu starten
        </button>
        <button
          aria-label="Update-Hinweis ausblenden"
          title="Diese Version überspringen — Banner erscheint erst beim nächsten Modell-Update wieder"
          className="titlebar-no-drag flex h-7 w-7 items-center justify-center rounded-md text-info-text transition-colors hover:bg-info-border/40"
          onClick={onDismiss}
        >
          <X className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
