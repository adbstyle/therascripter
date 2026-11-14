import { useCallback, useEffect, useState } from 'react'
import FirstLaunchScreen from './components/FirstLaunchScreen'
import TitleBar from './components/shell/TitleBar'
import AppShell from './components/shell/AppShell'
import { NavigationProvider } from './navigation/NavigationContext'
import { RecordingProvider } from './contexts/RecordingContext'
import { WorkspaceActionsProvider } from './contexts/WorkspaceActionsContext'

/**
 * Wurzel der App: Provider plus Shell bzw. Ersteinrichtung (Epic #192).
 * Navigation, Aufnahme und gemeinsame Aktionen leben in den Providern, die
 * Oberfläche in `AppShell`.
 */
export default function App(): React.JSX.Element {
  const [modelsReady, setModelsReady] = useState<boolean | null>(null)

  useEffect(() => {
    window.api.modelDownload.status().then((info) => setModelsReady(info.modelsReady))
  }, [])

  const handleModelsComplete = useCallback(() => setModelsReady(true), [])

  return (
    <NavigationProvider>
      <RecordingProvider>
        <WorkspaceActionsProvider>
          {modelsReady ? (
            <AppShell />
          ) : (
            // Ladezustand und Ersteinrichtung: ohne Seitenleiste und Navigation
            <div className="flex h-screen flex-col bg-surface-0">
              <TitleBar variant="minimal" />
              <div className="min-h-0 flex-1">
                {modelsReady === false && <FirstLaunchScreen onComplete={handleModelsComplete} />}
              </div>
            </div>
          )}
        </WorkspaceActionsProvider>
      </RecordingProvider>
    </NavigationProvider>
  )
}
