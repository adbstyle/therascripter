import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Circle, Loader2 } from 'lucide-react'
import type { ModelDownloadProgress, ModelDownloadStatus } from '../../../shared/types'
import type { PendingModelUpdate } from '../../../shared/types/ModelUpdate'
import { formatBytes } from '../utils/formatBytes'
import AppLogo from './AppLogo'

interface ModelUpdateScreenProps {
  updates: PendingModelUpdate[]
  onComplete: () => void
}

export default function ModelUpdateScreen({
  updates,
  onComplete
}: ModelUpdateScreenProps): React.JSX.Element {
  const [status, setStatus] = useState<ModelDownloadStatus>({ state: 'idle' })
  const [started, setStarted] = useState(false)
  const lastProgressRef = useRef<ModelDownloadProgress | null>(null)

  useEffect(() => {
    const unsubProgress = window.api.modelUpdate.onDownloadProgress((s) => {
      if (s.state === 'downloading') {
        lastProgressRef.current = s.progress
      }
      setStatus(s)
    })

    const unsubComplete = window.api.modelUpdate.onDownloadComplete(() => {
      setStatus({ state: 'complete' })
      onComplete()
    })

    const unsubError = window.api.modelUpdate.onDownloadError((error) => {
      setStatus({ state: 'error', error, modelId: '' })
    })

    return () => {
      unsubProgress()
      unsubComplete()
      unsubError()
    }
  }, [onComplete])

  const handleStart = useCallback(async () => {
    setStarted(true)
    setStatus({
      state: 'downloading',
      progress: {
        currentModel: '',
        currentModelLabel: '',
        currentModelProgress: 0,
        currentModelDownloaded: 0,
        currentModelTotal: 0,
        overallDownloaded: 0,
        overallTotal: updates.reduce((sum, u) => sum + u.sizeBytes, 0),
        overallPercent: 0
      }
    })
    await window.api.modelUpdate.startDownload()
  }, [updates])

  const handleSkip = useCallback(async () => {
    // Clear pending updates in settings so the screen doesn't reappear next launch
    await window.api.modelUpdate.clearPending()
    onComplete()
  }, [onComplete])

  const isDownloading = status.state === 'downloading'
  const isExtracting = status.state === 'extracting'
  const isVerifying = status.state === 'verifying'
  const isError = status.state === 'error'
  const progress = isDownloading ? status.progress : null
  const displayProgress = progress ?? lastProgressRef.current

  const currentModelId =
    progress?.currentModel ||
    (isExtracting ? status.modelId : null) ||
    (isVerifying ? status.modelId : null)

  const currentModelIndex = currentModelId ? updates.findIndex((u) => u.id === currentModelId) : -1

  return (
    <div className="flex h-full flex-col items-center justify-center bg-surface-0">
      <div className="w-full max-w-lg px-8">
        {/* Header */}
        <div className="mb-8 text-center">
          <AppLogo size={72} className="mx-auto mb-3" />
          <h1 className="mb-2 text-2xl font-bold text-text-primary">Modelle werden aktualisiert</h1>
          <p className="text-sm text-text-secondary">
            Verbesserte Modellversionen werden heruntergeladen. Bestehende Modelle bleiben bis zum
            erfolgreichen Abschluss erhalten.
          </p>
        </div>

        {!started && (
          <div className="mb-8 text-center">
            <p className="mb-6 text-sm text-text-secondary">
              {updates.length} {updates.length === 1 ? 'Modell wird' : 'Modelle werden'}{' '}
              aktualisiert (~{formatBytes(updates.reduce((s, u) => s + u.sizeBytes, 0))}).
            </p>
            <div className="flex justify-center gap-3">
              <button
                className="rounded-lg border border-border-strong bg-surface-0 px-4 py-2.5 text-sm font-semibold text-text-secondary transition-colors hover:bg-surface-1"
                onClick={handleSkip}
              >
                Überspringen
              </button>
              <button
                className="rounded-lg bg-primary px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover"
                onClick={handleStart}
              >
                Update starten
              </button>
            </div>
          </div>
        )}

        {/* Download progress */}
        {started && (
          <div className="rounded-lg border border-border p-5">
            {updates.map((update, index) => {
              const isCurrent = update.id === currentModelId
              const isCompleted = currentModelIndex > 0 && index < currentModelIndex

              return (
                <div key={update.id} className="mb-3 last:mb-0">
                  <div className="mb-1 flex items-center justify-between">
                    <span
                      className={`flex items-center gap-1.5 text-sm ${isCurrent ? 'font-medium text-text-primary' : 'text-text-tertiary'}`}
                    >
                      {isCompleted ? (
                        <Check className="h-4 w-4 text-success" strokeWidth={2.5} aria-hidden />
                      ) : isCurrent ? (
                        <Loader2 className="h-4 w-4 animate-spin text-primary" strokeWidth={2} aria-hidden />
                      ) : (
                        <Circle className="h-4 w-4 text-text-tertiary" strokeWidth={1.5} aria-hidden />
                      )}
                      {update.label}
                    </span>
                    <span className="text-xs text-text-tertiary">
                      {formatBytes(update.sizeBytes)}
                    </span>
                  </div>
                  {isCurrent && isDownloading && progress && (
                    <div className="h-2 overflow-hidden rounded-full bg-surface-2">
                      <div
                        className="h-full rounded-full bg-primary transition-all duration-300"
                        style={{ width: `${progress.currentModelProgress}%` }}
                      />
                    </div>
                  )}
                  {isCurrent && isExtracting && (
                    <p className="text-xs text-text-tertiary">Wird entpackt…</p>
                  )}
                  {isCurrent && isVerifying && (
                    <p className="text-xs text-text-tertiary">Wird überprüft…</p>
                  )}
                </div>
              )
            })}

            {/* Overall progress */}
            {displayProgress && (
              <div className="mt-4 border-t border-border pt-3">
                <div className="mb-1 flex items-center justify-between text-xs text-text-tertiary">
                  <span>Gesamt</span>
                  <span>
                    {formatBytes(displayProgress.overallDownloaded)} /{' '}
                    {formatBytes(displayProgress.overallTotal)}
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-surface-2">
                  <div
                    className="h-full rounded-full bg-primary transition-all duration-300"
                    style={{ width: `${displayProgress.overallPercent}%` }}
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {/* Error state */}
        {isError && (
          <div className="mt-4 rounded-lg border border-error-border bg-error-bg p-4">
            <p className="mb-2 text-sm font-medium text-error-text-emphasis">
              Update fehlgeschlagen
            </p>
            <p className="mb-3 text-sm text-error-text">{status.error}</p>
            <p className="mb-3 text-xs text-text-tertiary">
              Bestehende Modelle sind unverändert. Das Update wird beim nächsten Start
              erneut versucht.
            </p>
            <button
              className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-hover"
              onClick={handleSkip}
            >
              Weiter
            </button>
          </div>
        )}

        {started && !isError && (
          <p className="mt-4 text-center text-xs text-text-tertiary">
            Hinweis: Bei Abbruch wird das Update beim nächsten Start automatisch fortgesetzt.
          </p>
        )}
      </div>
    </div>
  )
}
