import { useCallback, useEffect, useRef, useState } from 'react'
import { FileText, Mic } from 'lucide-react'
import SessionDashboard from './components/SessionDashboard'
import RecordingView from './components/RecordingView'
import FirstLaunchScreen from './components/FirstLaunchScreen'
import ModelUpdateScreen from './components/ModelUpdateScreen'
import UpdateBanner from './components/UpdateBanner'
import TitleBar from './components/shell/TitleBar'
import BottomNav from './components/shell/BottomNav'
import Settings from './views/Settings'
import ReviewEditor from './views/ReviewEditor'
import { useRecording } from './hooks/useRecording'
import { useModelUpdates } from './hooks/useModelUpdates'
import type { PendingModelUpdate } from '../../shared/types/ModelUpdate'

type View = 'sessions' | 'settings' | 'review'

export default function App(): React.JSX.Element {
  const { isRecording, duration, level, error, startRecording, stopRecording } = useRecording()
  const { availableUpdates, clearUpdates } = useModelUpdates()
  const [modelsReady, setModelsReady] = useState<boolean | null>(null)
  const [pendingUpdates, setPendingUpdates] = useState<PendingModelUpdate[] | null>(null)
  const [currentView, setCurrentView] = useState<View>('sessions')
  const [refreshTrigger, setRefreshTrigger] = useState(0)
  const [isImporting, setIsImporting] = useState(false)
  const [reviewSessionId, setReviewSessionId] = useState<string | null>(null)
  // Bumped on every tray/app-menu "Einstellungen…" trigger to force <Settings/>
  // to remount with fresh subpage state — guarantees we land on the overview
  // even when the user is already deep in a sub-page (AC #7).
  const [settingsResetKey, setSettingsResetKey] = useState(0)
  const scrollToSessionId = useRef<string | null>(null)

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

  useEffect(() => {
    return window.api.nav.onOpenSettings(() => {
      setReviewSessionId(null)
      setCurrentView('settings')
      setSettingsResetKey((k) => k + 1)
    })
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
    scrollToSessionId.current = reviewSessionId
    setReviewSessionId(null)
    setCurrentView('sessions')
    setRefreshTrigger((v) => v + 1)
  }, [reviewSessionId])

  const handleScrollComplete = useCallback(() => {
    scrollToSessionId.current = null
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
  const navHidden = isRecording || isInReview

  const headerTitle = isRecording
    ? 'Aufnahme läuft'
    : currentView === 'sessions'
      ? 'Transkriptionen'
      : currentView === 'settings'
        ? 'Einstellungen'
        : ''

  // Show loading state while checking models
  if (modelsReady === null) {
    return (
      <div className="flex h-screen flex-col bg-surface-0">
        <TitleBar />
        <div className="flex-1" />
      </div>
    )
  }

  // First launch: show model download screen
  if (!modelsReady) {
    return (
      <div className="flex h-screen flex-col bg-surface-0">
        <TitleBar />
        <div className="min-h-0 flex-1">
          <FirstLaunchScreen onComplete={handleModelsComplete} />
        </div>
      </div>
    )
  }

  // Pending model updates (set before restart): show update download screen
  if (pendingUpdates !== null) {
    return (
      <div className="flex h-screen flex-col bg-surface-0">
        <TitleBar />
        <div className="min-h-0 flex-1">
          <ModelUpdateScreen updates={pendingUpdates} onComplete={handleUpdateComplete} />
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col bg-surface-0">
      <TitleBar />

      {/* Update banner — shown when updates are available (non-blocking) */}
      {availableUpdates && availableUpdates.length > 0 && (
        <UpdateBanner updates={availableUpdates} onRestart={handleRestartForUpdate} />
      )}

      {/* Main content */}
      <main className="flex min-h-0 flex-1 flex-col">
        {/* Header — sessions + recording. Settings renders its own breadcrumb header.
            Review has its own header. */}
        {!isInReview && currentView !== 'settings' && (
          <header className="flex h-[72px] shrink-0 items-center justify-between border-b border-border px-6">
            <h2 className="text-2xl font-bold text-text-primary">{headerTitle}</h2>
            {!isRecording && currentView === 'sessions' && (
              <div className="flex items-center gap-2">
                <button
                  className={`titlebar-no-drag flex items-center gap-2 rounded-lg border border-border-strong bg-surface-0 px-4 py-2 text-sm font-semibold text-text-secondary transition-colors hover:bg-surface-1 ${isImporting ? 'pointer-events-none opacity-50' : ''}`}
                  onClick={handleImportPDF}
                  disabled={isImporting}
                >
                  <FileText className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                  PDF importieren
                </button>
                <button
                  className="titlebar-no-drag flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-hover"
                  onClick={startRecording}
                >
                  <Mic className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
                  Aufnahme starten
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
            scrollToSessionId={scrollToSessionId.current}
            onScrollComplete={handleScrollComplete}
          />
        ) : (
          <Settings key={settingsResetKey} />
        )}

        {!navHidden && <BottomNav current={currentView} onChange={setCurrentView} />}
      </main>
    </div>
  )
}
