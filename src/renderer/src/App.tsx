import { useCallback, useEffect, useRef, useState } from 'react'
import { FileText, Mic } from 'lucide-react'
import SessionDashboard from './components/SessionDashboard'
import FirstLaunchScreen from './components/FirstLaunchScreen'
import ModelUpdateScreen from './components/ModelUpdateScreen'
import UpdateBanner from './components/UpdateBanner'
import { ConsentBanner } from './components/ConsentBanner'
import TitleBar from './components/shell/TitleBar'
import BottomNav from './components/shell/BottomNav'
import RecordingBar from './components/shell/RecordingBar'
import Settings from './views/Settings'
import ReviewEditor from './views/ReviewEditor'
import { useRecording } from './hooks/useRecording'
import { useModelUpdates } from './hooks/useModelUpdates'
import { useToast } from './hooks/useToast'
import type { PendingModelUpdate } from '../../shared/types/ModelUpdate'

type View = 'sessions' | 'settings' | 'review'

export default function App(): React.JSX.Element {
  const { isRecording, duration, level, error, startRecording, stopRecording } = useRecording()
  const { availableUpdates, clearUpdates } = useModelUpdates()
  const toast = useToast()
  const [modelsReady, setModelsReady] = useState<boolean | null>(null)
  const [pendingUpdates, setPendingUpdates] = useState<PendingModelUpdate[] | null>(null)
  const [currentView, setCurrentView] = useState<View>('sessions')
  const [refreshTrigger, setRefreshTrigger] = useState(0)
  const [isImporting, setIsImporting] = useState(false)
  const [reviewSessionId, setReviewSessionId] = useState<string | null>(null)
  // Bumped on every tray/app-menu "Einstellungen…" trigger to force <Settings/>
  // to remount with fresh subpage state — guarantees we land on the overview
  // even when the user is already deep in a sub-page.
  const [settingsResetKey, setSettingsResetKey] = useState(0)
  // Pro Aufnahme: wurde der Consent-Hinweis weggeklickt? Muss hier leben
  // (nicht im Banner) — die Sessions-View wird bei Navigation unmounted.
  const [consentDismissed, setConsentDismissed] = useState(false)
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

  // Aufnahme-Transitionen: bei Start zur Liste navigieren (dort lebt die
  // Live-Karte), bei Start UND Stop die Liste refetchen, damit die Karte
  // mit Status 'recording' sofort erscheint bzw. auf 'queued' umspringt.
  // Kein Forced-Navigate beim Stop — wer in Review/Settings ist, bleibt dort.
  const prevRecording = useRef(false)
  useEffect(() => {
    if (isRecording && !prevRecording.current) {
      setCurrentView('sessions')
      setReviewSessionId(null)
      setConsentDismissed(false)
      setRefreshTrigger((v) => v + 1)
    } else if (!isRecording && prevRecording.current) {
      setRefreshTrigger((v) => v + 1)
    }
    prevRecording.current = isRecording
  }, [isRecording])

  // Mikrofon-/Aufnahmefehler als Toast: seit dem Wegfall der Vollbild-
  // RecordingView gibt es keinen dedizierten Anzeigeort mehr. (Vorher war
  // ein Fehler beim Start sogar unsichtbar — die View mountete nie.)
  // Dep auf toast.error (stabiler useCallback), NICHT auf das pro Render
  // neu gebaute Context-Objekt — sonst re-triggert jeder neue Toast den Effekt.
  const showErrorToast = toast.error
  useEffect(() => {
    if (error) showErrorToast(error)
  }, [error, showErrorToast])

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

  // Issue #84 / Story G — "Später" + Error-Continue exits leave the
  // pending entry in electron-store intact (next-launch retry promise) and
  // must not clear the live banner state — the user did not dismiss the
  // update, only the current screen.
  const handleUpdateLater = useCallback(() => {
    setPendingUpdates(null)
  }, [])

  // "Zur Aufnahme" aus der RecordingBar: zur Liste (Live-Karte) wechseln.
  // Verlässt ggf. auch den Review-Editor — reviewSessionId miträumen wie
  // beim Settings-Trigger aus dem App-Menü.
  const handleOpenRecording = useCallback(() => {
    setReviewSessionId(null)
    setCurrentView('sessions')
  }, [])

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

  const handleDismissUpdates = useCallback(async () => {
    if (!availableUpdates || availableUpdates.length === 0) return
    await window.api.modelUpdate.dismissVersions(availableUpdates)
    clearUpdates()
  }, [availableUpdates, clearUpdates])

  const isInReview = currentView === 'review'

  const headerTitle =
    currentView === 'sessions'
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
          <ModelUpdateScreen
            updates={pendingUpdates}
            onComplete={handleUpdateComplete}
            onLater={handleUpdateLater}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col bg-surface-0">
      <TitleBar />

      {/* Update banner — shown when updates are available (non-blocking) */}
      {availableUpdates && availableUpdates.length > 0 && (
        <UpdateBanner
          updates={availableUpdates}
          onRestart={handleRestartForUpdate}
          onDismiss={handleDismissUpdates}
        />
      )}

      {/* Aufnahme-Leiste — nur wo die Live-Karte nicht sichtbar ist
          (Settings, Review). Auf der Sessions-Liste übernimmt die Karte. */}
      {isRecording && currentView !== 'sessions' && (
        <RecordingBar duration={duration} onOpenRecording={handleOpenRecording} />
      )}

      {/* Main content */}
      <main className="flex min-h-0 flex-1 flex-col">
        {/* Header — sessions + recording. Settings renders its own breadcrumb header.
            Review has its own header. */}
        {!isInReview && currentView !== 'settings' && (
          <header className="flex h-[72px] shrink-0 items-center justify-between border-b border-border px-6">
            <h2 className="text-2xl font-bold text-text-primary">{headerTitle}</h2>
            {currentView === 'sessions' && (
              <div className="flex items-center gap-2">
                <button
                  className={`titlebar-no-drag flex items-center gap-2 rounded-lg border border-border-strong bg-surface-0 px-4 py-2 text-sm font-semibold text-text-secondary transition-colors hover:bg-surface-1 ${isImporting ? 'pointer-events-none opacity-50' : ''}`}
                  onClick={handleImportPDF}
                  disabled={isImporting}
                >
                  <FileText className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                  PDF importieren
                </button>
                {!isRecording && (
                  <button
                    className="titlebar-no-drag flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-hover"
                    onClick={startRecording}
                  >
                    <Mic className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
                    Aufnahme starten
                  </button>
                )}
              </div>
            )}
          </header>
        )}

        {currentView === 'review' && reviewSessionId ? (
          <ReviewEditor sessionId={reviewSessionId} onBack={handleCloseReview} />
        ) : currentView === 'sessions' ? (
          <>
            {isRecording && !consentDismissed && (
              <ConsentBanner onDismiss={() => setConsentDismissed(true)} />
            )}
            <SessionDashboard
              refreshTrigger={refreshTrigger}
              isImporting={isImporting}
              onImportingChange={setIsImporting}
              onOpenReview={handleOpenReview}
              scrollToSessionId={scrollToSessionId.current}
              onScrollComplete={handleScrollComplete}
              liveRecording={isRecording ? { duration, level, onStop: stopRecording } : null}
            />
          </>
        ) : (
          <Settings key={settingsResetKey} />
        )}

        {!isInReview && <BottomNav current={currentView} onChange={setCurrentView} />}
      </main>
    </div>
  )
}
