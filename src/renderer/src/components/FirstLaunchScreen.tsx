import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Circle, Loader2 } from 'lucide-react'
import type {
  ModelDownloadProgress,
  ModelDownloadStatus,
  ModelStatusInfo,
  DiskSpaceInfo
} from '../../../shared/types'
import { formatBytes } from '../utils/formatBytes'
import AppLogo from './AppLogo'

interface FirstLaunchScreenProps {
  onComplete: () => void
}

export default function FirstLaunchScreen({
  onComplete
}: FirstLaunchScreenProps): React.JSX.Element {
  const [modelInfo, setModelInfo] = useState<ModelStatusInfo | null>(null)
  const [diskSpace, setDiskSpace] = useState<DiskSpaceInfo | null>(null)
  const [status, setStatus] = useState<ModelDownloadStatus>({ state: 'idle' })
  const [started, setStarted] = useState(false)
  const lastProgressRef = useRef<ModelDownloadProgress | null>(null)

  useEffect(() => {
    window.api.modelDownload.status().then(setModelInfo)
    window.api.modelDownload.checkDiskSpace().then(setDiskSpace)

    const unsub = window.api.modelDownload.onStatus((s) => {
      if (s.state === 'downloading') {
        lastProgressRef.current = s.progress
      }
      setStatus(s)
      if (s.state === 'complete') {
        onComplete()
      }
    })

    return unsub
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
        overallTotal: 1,
        overallPercent: 0
      }
    })
    await window.api.modelDownload.start()
  }, [])

  // Disk space error
  if (diskSpace && !diskSpace.sufficient) {
    return (
      <div className="flex h-full items-center justify-center bg-surface-0">
        <div className="max-w-md text-center">
          <div className="mb-4 text-4xl">&#9888;</div>
          <h2 className="mb-2 text-lg font-semibold text-text-primary">
            Nicht genügend Speicherplatz
          </h2>
          <p className="mb-4 text-sm text-text-secondary">
            TheraScript benötigt mindestens 5 GB freien Speicherplatz für die ML-Modelle.
          </p>
          <div className="mb-4 text-sm text-text-tertiary">
            <p>Verfügbar: {formatBytes(diskSpace.availableBytes)}</p>
            <p>Benötigt: ~5.0 GB</p>
          </div>
          <p className="text-sm text-text-tertiary">
            Bitte schaffen Sie Speicherplatz frei und starten Sie die App erneut.
          </p>
        </div>
      </div>
    )
  }

  const isDownloading = status.state === 'downloading'
  const isExtracting = status.state === 'extracting'
  const isVerifying = status.state === 'verifying'
  const isError = status.state === 'error'
  const progress = isDownloading ? status.progress : null
  // Keep overall progress bar visible during extracting/verifying states
  const displayProgress = progress ?? lastProgressRef.current

  // Find which model is currently being processed
  const currentModelId =
    progress?.currentModel ||
    (isExtracting ? status.modelId : null) ||
    (isVerifying ? status.modelId : null)

  return (
    <div className="flex h-full flex-col items-center justify-center bg-surface-0">
      <div className="w-full max-w-lg px-8">
        {/* Header */}
        <div className="mb-8 text-center">
          <AppLogo size={72} className="mx-auto mb-3" />
          <h1 className="mb-2 text-2xl font-bold text-text-primary">TheraScript</h1>
          <p className="text-sm text-text-secondary">
            Alle Verarbeitung findet komplett lokal auf Ihrem Mac statt — keine Daten verlassen Ihr
            Gerät.
          </p>
        </div>

        {!started && (
          <div className="mb-8 text-center">
            <p className="mb-6 text-sm text-text-secondary">
              Zum Start werden die Standard-ML-Modelle heruntergeladen
              {modelInfo && modelInfo.models.length > 0 && (
                <> ({formatBytes(modelInfo.models.reduce((sum, m) => sum + m.sizeBytes, 0))})</>
              )}
              . Weitere oder alternative Modelle können Sie jederzeit unter Einstellungen &rarr;
              Modelle hinzufügen.
            </p>
            <button
              className="rounded-lg bg-primary px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover"
              onClick={handleStart}
            >
              Download starten
            </button>
          </div>
        )}

        {/* Download progress */}
        {started && (
          <div className="rounded-lg border border-border p-5">
            {modelInfo?.models.map((model) => {
              const isCurrent = model.id === currentModelId
              const isCompleted =
                currentModelId &&
                modelInfo.models.indexOf(model) <
                  modelInfo.models.findIndex((m) => m.id === currentModelId)

              return (
                <div key={model.id} className="mb-3 last:mb-0">
                  <div className="mb-1 flex items-center justify-between">
                    <span
                      className={`flex items-center gap-1.5 text-sm ${isCurrent ? 'font-medium text-text-primary' : 'text-text-tertiary'}`}
                    >
                      {isCompleted ? (
                        <Check className="h-4 w-4 text-success" strokeWidth={2.5} aria-hidden />
                      ) : isCurrent ? (
                        <Loader2
                          className="h-4 w-4 animate-spin text-primary"
                          strokeWidth={2}
                          aria-hidden
                        />
                      ) : (
                        <Circle
                          className="h-4 w-4 text-text-tertiary"
                          strokeWidth={1.5}
                          aria-hidden
                        />
                      )}
                      {model.label}
                    </span>
                    <span className="text-xs text-text-tertiary">
                      {formatBytes(model.sizeBytes)}
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
              Download fehlgeschlagen
            </p>
            <p className="mb-3 text-sm text-error-text">{status.error}</p>
            <button
              className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-hover"
              onClick={handleStart}
            >
              Erneut versuchen
            </button>
          </div>
        )}

        {/* Resume hint */}
        {started && !isError && (
          <p className="mt-4 text-center text-xs text-text-tertiary">
            Hinweis: Bei Abbruch wird der Download beim nächsten Start automatisch fortgesetzt.
          </p>
        )}
      </div>
    </div>
  )
}
