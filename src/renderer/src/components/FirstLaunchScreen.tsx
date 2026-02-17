import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ModelDownloadProgress,
  ModelDownloadStatus,
  ModelStatusInfo,
  DiskSpaceInfo
} from '../../../shared/types'

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

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
    setStatus({ state: 'downloading', progress: {
      currentModel: '',
      currentModelLabel: '',
      currentModelProgress: 0,
      currentModelDownloaded: 0,
      currentModelTotal: 0,
      overallDownloaded: 0,
      overallTotal: 1,
      overallPercent: 0
    }})
    await window.api.modelDownload.start()
  }, [])

  // Disk space error
  if (diskSpace && !diskSpace.sufficient) {
    return (
      <div className="flex h-screen items-center justify-center bg-white">
        <div className="max-w-md text-center">
          <div className="mb-4 text-4xl">&#9888;</div>
          <h2 className="mb-2 text-lg font-semibold text-gray-900">
            Nicht genügend Speicherplatz
          </h2>
          <p className="mb-4 text-sm text-gray-600">
            Therascript benötigt mindestens 5 GB freien Speicherplatz für die ML-Modelle.
          </p>
          <div className="mb-4 text-sm text-gray-500">
            <p>Verfügbar: {formatBytes(diskSpace.availableBytes)}</p>
            <p>Benötigt: ~5.0 GB</p>
          </div>
          <p className="text-sm text-gray-500">
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
    <div className="flex h-screen flex-col items-center justify-center bg-white">
      <div className="w-full max-w-lg px-8">
        {/* Header */}
        <div className="titlebar-drag mb-8 text-center">
          <div className="mb-2 text-sm text-gray-400">&#128274; Therascript</div>
          <h1 className="mb-2 text-2xl font-bold text-gray-900">Willkommen bei Therascript</h1>
          <p className="text-sm text-gray-600">
            Alle Verarbeitung findet komplett lokal auf Ihrem Mac statt — keine Daten verlassen Ihr
            Gerät.
          </p>
        </div>

        {!started && (
          <div className="mb-8 text-center">
            <p className="mb-6 text-sm text-gray-600">
              Für die erste Einrichtung werden ML-Modelle heruntergeladen (~2.2 GB). Dies ist der
              einzige Zeitpunkt, an dem eine Internetverbindung nötig ist.
            </p>
            <button
              className="rounded-lg bg-primary px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
              onClick={handleStart}
            >
              Download starten
            </button>
          </div>
        )}

        {/* Download progress */}
        {started && (
          <div className="rounded-lg border border-gray-200 p-5">
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
                      className={`text-sm ${isCurrent ? 'font-medium text-gray-900' : 'text-gray-500'}`}
                    >
                      {isCompleted ? '✓ ' : isCurrent ? '' : '○ '}
                      {model.label}
                    </span>
                    <span className="text-xs text-gray-400">{formatBytes(model.sizeBytes)}</span>
                  </div>
                  {isCurrent && isDownloading && progress && (
                    <div className="h-2 overflow-hidden rounded-full bg-gray-200">
                      <div
                        className="h-full rounded-full bg-primary transition-all duration-300"
                        style={{ width: `${progress.currentModelProgress}%` }}
                      />
                    </div>
                  )}
                  {isCurrent && isExtracting && (
                    <p className="text-xs text-gray-400">Wird entpackt…</p>
                  )}
                  {isCurrent && isVerifying && (
                    <p className="text-xs text-gray-400">Wird überprüft…</p>
                  )}
                </div>
              )
            })}

            {/* Overall progress */}
            {displayProgress && (
              <div className="mt-4 border-t border-gray-100 pt-3">
                <div className="mb-1 flex items-center justify-between text-xs text-gray-500">
                  <span>Gesamt</span>
                  <span>
                    {formatBytes(displayProgress.overallDownloaded)} /{' '}
                    {formatBytes(displayProgress.overallTotal)}
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-gray-200">
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
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4">
            <p className="mb-2 text-sm font-medium text-red-800">Download fehlgeschlagen</p>
            <p className="mb-3 text-sm text-red-600">{status.error}</p>
            <button
              className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
              onClick={handleStart}
            >
              Erneut versuchen
            </button>
          </div>
        )}

        {/* Resume hint */}
        {started && !isError && (
          <p className="mt-4 text-center text-xs text-gray-400">
            Hinweis: Bei Abbruch wird der Download beim nächsten Start automatisch fortgesetzt.
          </p>
        )}
      </div>
    </div>
  )
}
