import { useCallback, useState } from 'react'
import SessionDashboard from './components/SessionDashboard'
import RecordingView from './components/RecordingView'
import Settings from './views/Settings'
import { useRecording } from './hooks/useRecording'

type View = 'sessions' | 'settings'

export default function App(): React.JSX.Element {
  const { isRecording, duration, level, error, startRecording, stopRecording } = useRecording()
  const [currentView, setCurrentView] = useState<View>('sessions')
  const [refreshTrigger, setRefreshTrigger] = useState(0)

  const handleImportPDF = useCallback(async () => {
    const filePaths = await window.api.import.showPDFDialog()
    if (filePaths.length === 0) return
    await window.api.import.pdf(filePaths)
    setRefreshTrigger((v) => v + 1)
  }, [])

  const headerTitle = isRecording
    ? 'Aufnahme läuft'
    : currentView === 'sessions'
      ? 'Sitzungen'
      : 'Einstellungen'

  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <aside className="flex w-[200px] flex-col border-r border-gray-200 bg-white px-4 py-6">
        <h1 className="titlebar-drag mb-8 text-base font-semibold text-gray-900">THERASCRIPT</h1>
        <nav className="flex flex-1 flex-col gap-1">
          <button
            className={`titlebar-no-drag rounded-md px-3 py-2 text-left text-sm font-medium transition-colors ${
              currentView === 'sessions'
                ? 'bg-gray-100 text-gray-900'
                : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
            } ${isRecording ? 'pointer-events-none opacity-50' : ''}`}
            onClick={() => setCurrentView('sessions')}
            disabled={isRecording}
          >
            Sitzungen
          </button>
          <button
            className={`titlebar-no-drag rounded-md px-3 py-2 text-left text-sm font-medium transition-colors ${
              currentView === 'settings'
                ? 'bg-gray-100 text-gray-900'
                : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
            } ${isRecording ? 'pointer-events-none opacity-50' : ''}`}
            onClick={() => setCurrentView('settings')}
            disabled={isRecording}
          >
            Einstellungen
          </button>
        </nav>
        <div className="flex items-center gap-1.5 text-xs text-gray-400">
          <span>&#128274;</span>
          <span>Lokal</span>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex flex-1 flex-col">
        {/* Header — draggable titlebar region */}
        <header className="titlebar-drag flex items-center justify-between border-b border-gray-200 px-6 py-4">
          <h2 className="text-2xl font-bold text-gray-900">{headerTitle}</h2>
          {!isRecording && currentView === 'sessions' && (
            <div className="flex items-center gap-2">
              <button
                className="titlebar-no-drag rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50"
                onClick={handleImportPDF}
              >
                PDF importieren
              </button>
              <button
                className="titlebar-no-drag rounded-lg bg-recording px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-700"
                onClick={startRecording}
              >
                &#9679; Aufnahme starten
              </button>
            </div>
          )}
        </header>

        {isRecording ? (
          <RecordingView
            duration={duration}
            level={level}
            error={error}
            onStop={stopRecording}
          />
        ) : currentView === 'sessions' ? (
          <SessionDashboard refreshTrigger={refreshTrigger} />
        ) : (
          <Settings />
        )}
      </main>
    </div>
  )
}
