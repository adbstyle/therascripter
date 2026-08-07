import { Component, type ErrorInfo, type ReactNode } from 'react'
import { TriangleAlert } from 'lucide-react'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

/**
 * Last-Resort-Fallback um den Renderer-Root: ohne Boundary reisst ein
 * unbehandelter Render-Fehler den kompletten React-Tree ab und der User
 * sieht nur noch ein weisses Fenster — inklusive einer evtl. laufenden
 * Aufnahme ohne jedes Feedback.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary] Unbehandelter Render-Fehler:', error, info.componentStack)
  }

  private handleReload = (): void => {
    window.location.reload()
  }

  render(): ReactNode {
    if (this.state.error === null) {
      return this.props.children
    }

    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-background px-8 text-center">
        <TriangleAlert className="h-10 w-10 text-red-500" strokeWidth={1.5} aria-hidden />
        <h1 className="text-lg font-semibold text-text-primary">
          Ein unerwarteter Fehler ist aufgetreten
        </h1>
        <p className="max-w-md text-sm text-text-secondary">
          Die Ansicht konnte nicht dargestellt werden. Ihre Daten sind gespeichert — laden Sie die
          Ansicht neu, um weiterzuarbeiten.
        </p>
        <p className="max-w-md break-all font-mono text-xs text-text-tertiary">
          {this.state.error.message}
        </p>
        <button
          type="button"
          onClick={this.handleReload}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          Neu laden
        </button>
      </div>
    )
  }
}
