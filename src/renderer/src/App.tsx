import { useCallback, useEffect, useRef, useState } from 'react'
import { FileText, Mic } from 'lucide-react'
import SessionDashboard from './components/SessionDashboard'
import FirstLaunchScreen from './components/FirstLaunchScreen'
import MicrophoneBanner from './components/MicrophoneBanner'
import { ConsentBanner } from './components/ConsentBanner'
import TitleBar from './components/shell/TitleBar'
import BottomNav from './components/shell/BottomNav'
import RecordingBar from './components/shell/RecordingBar'
import Settings, { type SubPage } from './views/Settings'
import ReviewEditor from './views/ReviewEditor'
import { useRecording } from './hooks/useRecording'
import { useMicrophonePermission } from './hooks/useMicrophonePermission'
import { useToolHealth } from './hooks/useToolHealth'
import ToolsBlockedBanner from './components/ToolsBlockedBanner'
import { useToast } from './hooks/useToast'

type View = 'sessions' | 'settings' | 'review'

export default function App(): React.JSX.Element {
  const microphone = useMicrophonePermission()
  const toolHealth = useToolHealth()
  // Pro App-Lauf ausgeblendet; nach dem nächsten Start kommt der Hinweis wieder
  const [toolsHintDismissed, setToolsHintDismissed] = useState(false)
  const { isRecording, level, duration, error, startRecording, stopRecording } = useRecording({
    onMicrophoneStatus: microphone.reportStatus
  })
  const toast = useToast()
  const [modelsReady, setModelsReady] = useState<boolean | null>(null)
  const [currentView, setCurrentView] = useState<View>('sessions')
  const [refreshTrigger, setRefreshTrigger] = useState(0)
  const [isImporting, setIsImporting] = useState(false)
  const [reviewSessionId, setReviewSessionId] = useState<string | null>(null)
  // Bumped on every tray/app-menu "Einstellungen…" trigger to force <Settings/>
  // to remount with fresh subpage state — guarantees we land on the overview
  // even when the user is already deep in a sub-page.
  const [settingsResetKey, setSettingsResetKey] = useState(0)
  // Unterseite beim nächsten Öffnen der Einstellungen (Hinweis «Update bereit»)
  const [settingsSubpage, setSettingsSubpage] = useState<SubPage | null>(null)
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

  // Aufnahmefehler als Toast: seit dem Wegfall der Vollbild-RecordingView
  // gibt es keinen dedizierten Anzeigeort mehr. Eine fehlende Mikrofon-
  // Berechtigung zeigt stattdessen der MicrophoneBanner (Issue #161).
  useEffect(() => {
    if (error) toast.error(error)
  }, [error, toast])

  useEffect(() => {
    return window.api.nav.onOpenSettings(() => {
      setReviewSessionId(null)
      setCurrentView('settings')
      setSettingsSubpage(null)
      setSettingsResetKey((k) => k + 1)
    })
  }, [])

  const handleOpenUpdates = useCallback(() => {
    setReviewSessionId(null)
    setCurrentView('settings')
    setSettingsSubpage('updates')
    setSettingsResetKey((k) => k + 1)
  }, [])

  const handleModelsComplete = useCallback(() => {
    setModelsReady(true)
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

  return (
    <div className="flex h-screen flex-col bg-surface-0">
      <TitleBar />

      {/* Von macOS blockierte Werkzeuge (Issue #168) — nie während einer Aufnahme */}
      {toolHealth.state?.status === 'blocked' && !toolsHintDismissed && !isRecording && (
        <ToolsBlockedBanner
          state={toolHealth.state}
          checking={toolHealth.checking}
          onOpenGuide={toolHealth.openGuide}
          onRecheck={() => void toolHealth.recheck()}
          onDismiss={() => setToolsHintDismissed(true)}
        />
      )}

      {/* Mikrofon-Berechtigung (Issue #161) — nie während einer Aufnahme */}
      {microphone.hint && !isRecording && (
        <MicrophoneBanner
          variant={microphone.hint}
          onAllow={microphone.allow}
          onOpenSettings={microphone.openSettings}
          onDismiss={microphone.dismiss}
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
          <Settings key={settingsResetKey} initialSubpage={settingsSubpage} />
        )}

        {!isInReview && (
          <BottomNav
            current={currentView}
            onChange={setCurrentView}
            onOpenUpdates={handleOpenUpdates}
          />
        )}
      </main>
    </div>
  )
}
