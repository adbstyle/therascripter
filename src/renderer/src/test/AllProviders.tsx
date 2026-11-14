import type { ReactNode } from 'react'
import { ThemeProvider } from '../contexts/ThemeContext'
import { ToastProvider } from '../contexts/ToastContext'
import { NavigationProvider } from '../navigation/NavigationContext'
import { RecordingProvider } from '../contexts/RecordingContext'
import { WorkspaceActionsProvider } from '../contexts/WorkspaceActionsContext'
import type { Route } from '../navigation/routes'

/** Alle Provider der App in derselben Reihenfolge wie `main.tsx` + `App.tsx`. */
export function AllProviders({
  children,
  route
}: {
  children: ReactNode
  route?: Route
}): React.JSX.Element {
  return (
    <ThemeProvider>
      <ToastProvider>
        <NavigationProvider initialRoute={route}>
          <RecordingProvider>
            <WorkspaceActionsProvider>{children}</WorkspaceActionsProvider>
          </RecordingProvider>
        </NavigationProvider>
      </ToastProvider>
    </ThemeProvider>
  )
}
