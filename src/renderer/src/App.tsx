import { useCallback, useEffect, useState } from 'react'
import SessionDashboard from './components/SessionDashboard'
import RecordingView from './components/RecordingView'
import FirstLaunchScreen from './components/FirstLaunchScreen'
import ModelUpdateScreen from './components/ModelUpdateScreen'
import UpdateBanner from './components/UpdateBanner'
import Settings from './views/Settings'
import ReviewEditor from './views/ReviewEditor'
import { useRecording } from './hooks/useRecording'
import { useModelUpdates } from './hooks/useModelUpdates'
import { useAppUpdate } from './hooks/useAppUpdate'
import type { PendingModelUpdate } from '../../shared/types/ModelUpdate'

type View = 'sessions' | 'settings' | 'review'

export default function App(): React.JSX.Element {
  const { isRecording, duration, level, error, startRecording, stopRecording } = useRecording()
  const { availableUpdates, clearUpdates } = useModelUpdates()
  const { status: appUpdateStatus, openReleasePage } = useAppUpdate()
  const [modelsReady, setModelsReady] = useState<boolean | null>(null)
  const [pendingUpdates, setPendingUpdates] = useState<PendingModelUpdate[] | null>(null)
  const [currentView, setCurrentView] = useState<View>('sessions')
  const [refreshTrigger, setRefreshTrigger] = useState(0)
  const [isImporting, setIsImporting] = useState(false)
  const [reviewSessionId, setReviewSessionId] = useState<string | null>(null)

  const handleImportPDF = useCallback(async () => {
    if (isImporting) return
    const filePaths = await window.api.import.showPDFDialog()
    if (filePaths.length === 0) return
    setIsImporting(true)
    try {
      await window.api.import.pdf(filePaths)
      setRefreshTrigger((v) => v + 1)
    } finally {
      setIsImporting(false)
    }
  }, [isImporting])

  const handleOpenReview = useCallback((sessionId: string) => {
    setReviewSessionId(sessionId)
    setCurrentView('review')
  }, [])

  useEffect(() => {
    window.api.modelDownload.status().then((info) => setModelsReady(info.modelsReady))
  }, [])

  // Check for pending model updates on startup (set before restart)
  // Note: background update check is now handled by main process (startup + 24h timer)
  useEffect(() => {
    if (modelsReady !== true) return
    window.api.modelUpdate.getPending().then((pending) => {
      if (pending && pending.length > 0) {
        setPendingUpdates(pending)
      }
    })
  }, [modelsReady])

  const handleModelsComplete = useCallback(() => {
    setModelsReady(true)
  }, [])

  const handleUpdateComplete = useCallback(() => {
    setPendingUpdates(null)
    clearUpdates()
  }, [clearUpdates])

  const handleCloseReview = useCallback(() => {
    setReviewSessionId(null)
    setCurrentView('sessions')
    setRefreshTrigger((v) => v + 1)
  }, [])

  const handleRestartForUpdate = useCallback(async () => {
    if (!availableUpdates) return

    const result = await window.api.modelUpdate.restart(availableUpdates)
    if (!result.allowed) {
      if (result.reason === 'recording') {
        alert('Bitte stoppen Sie zuerst die laufende Aufnahme.')
      } else if (result.reason === 'processing') {
        alert('Bitte warten Sie, bis die aktuelle Verarbeitung abgeschlossen ist.')
      }
    }
    // If allowed, the app will relaunch — no further action needed
  }, [availableUpdates])

  const isInReview = currentView === 'review'
  const sidebarDisabled = isRecording || isInReview

  const headerTitle = isRecording
    ? 'Aufnahme läuft'
    : currentView === 'sessions'
      ? 'Sitzungen'
      : currentView === 'settings'
        ? 'Einstellungen'
        : ''

  // Show loading state while checking models
  if (modelsReady === null) {
    return <div className="flex h-screen items-center justify-center bg-surface-0" />
  }

  // First launch: show model download screen
  if (!modelsReady) {
    return <FirstLaunchScreen onComplete={handleModelsComplete} />
  }

  // Pending model updates (set before restart): show update download screen
  if (pendingUpdates !== null) {
    return <ModelUpdateScreen updates={pendingUpdates} onComplete={handleUpdateComplete} />
  }

  return (
    <div className="flex h-screen flex-col bg-surface-0">
      {/* Update banner — shown when updates are available (non-blocking) */}
      {availableUpdates && availableUpdates.length > 0 && (
        <UpdateBanner updates={availableUpdates} onRestart={handleRestartForUpdate} />
      )}

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className="flex w-[200px] flex-col border-r border-border bg-surface-0 px-4 py-6">
          <div className="titlebar-drag mb-8" />
          <nav className="flex flex-1 flex-col gap-1">
            <button
              className={`titlebar-no-drag rounded-md px-3 py-2 text-left text-sm font-medium transition-colors ${
                currentView === 'sessions'
                  ? 'bg-surface-2 text-text-primary'
                  : 'text-text-secondary hover:bg-surface-1 hover:text-text-primary'
              } ${sidebarDisabled ? 'pointer-events-none opacity-50' : ''}`}
              onClick={() => setCurrentView('sessions')}
              disabled={sidebarDisabled}
            >
              Sitzungen
            </button>
            <button
              className={`titlebar-no-drag rounded-md px-3 py-2 text-left text-sm font-medium transition-colors ${
                currentView === 'settings'
                  ? 'bg-surface-2 text-text-primary'
                  : 'text-text-secondary hover:bg-surface-1 hover:text-text-primary'
              } ${sidebarDisabled ? 'pointer-events-none opacity-50' : ''}`}
              onClick={() => setCurrentView('settings')}
              disabled={sidebarDisabled}
            >
              Einstellungen
            </button>
          </nav>
          {appUpdateStatus?.available ? (
            <button
              className="titlebar-no-drag flex items-center gap-1.5 text-xs font-medium text-primary transition-colors hover:text-primary-hover"
              onClick={openReleasePage}
            >
              <span className="text-[10px]">&#9679;</span>
              <span>Update verf&#252;gbar</span>
            </button>
          ) : (
            <div className="flex items-center gap-1.5 text-xs text-text-tertiary">
              <span>&#128274;</span>
              <span>Lokal</span>
            </div>
          )}
        </aside>

        {/* Main content */}
        <main className="flex min-h-0 flex-1 flex-col">
          {/* Header — only for non-review views (review has its own header) */}
          {!isInReview && (
            <header className="titlebar-drag flex min-h-[71px] items-center justify-between border-b border-border px-6 py-4">
              <h2 className="text-2xl font-bold text-text-primary">{headerTitle}</h2>
              {!isRecording && currentView === 'sessions' && (
                <div className="flex items-center gap-2">
                  <button
                    className={`titlebar-no-drag rounded-lg border border-border-strong bg-surface-0 px-4 py-2 text-sm font-semibold text-text-secondary transition-colors hover:bg-surface-1 ${isImporting ? 'pointer-events-none opacity-50' : ''}`}
                    onClick={handleImportPDF}
                    disabled={isImporting}
                  >
                    PDF importieren
                  </button>
                  <button
                    className="titlebar-no-drag rounded-lg bg-recording px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-recording-hover"
                    onClick={startRecording}
                  >
                    &#9679; Aufnahme starten
                  </button>
                </div>
              )}
            </header>
          )}

          {isRecording ? (
            <RecordingView duration={duration} level={level} error={error} onStop={stopRecording} />
          ) : currentView === 'review' && reviewSessionId ? (
            <ReviewEditor sessionId={reviewSessionId} onBack={handleCloseReview} />
          ) : currentView === 'sessions' ? (
            <SessionDashboard
              refreshTrigger={refreshTrigger}
              isImporting={isImporting}
              onImportingChange={setIsImporting}
              onOpenReview={handleOpenReview}
            />
          ) : (
            <Settings />
          )}
        </main>
      </div>
    </div>
  )
}
