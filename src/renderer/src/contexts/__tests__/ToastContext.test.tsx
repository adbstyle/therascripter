import { describe, it, expect } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { ToastProvider } from '../ToastContext'
import { useToast } from '../../hooks/useToast'
import type { ToastContextValue } from '../toastTypes'

// Issue #140: Ein neues Context-Objekt pro Toast liess alle Konsumenten neu
// rendern und Effekte mit `toast` als Dependency erneut laufen — in
// ModelsSettings hiess das: Modellkatalog per IPC neu laden.
describe('ToastProvider', () => {
  it('behält den Context-Wert stabil, wenn ein Toast erscheint', () => {
    const seen: ToastContextValue[] = []
    function Consumer(): null {
      seen.push(useToast())
      return null
    }

    render(
      <ToastProvider>
        <Consumer />
      </ToastProvider>
    )
    act(() => seen[0].success('Gespeichert'))

    expect(screen.getByText('Gespeichert')).toBeInTheDocument()
    expect(new Set(seen).size).toBe(1)
  })

  // Epic #192: ohne untere Leiste sitzen die Toasts am unteren Fensterrand
  it('platziert die Toasts am unteren Rand, nicht über einer Leiste', () => {
    let toast: ToastContextValue | null = null
    function Consumer(): null {
      toast = useToast()
      return null
    }
    render(
      <ToastProvider>
        <Consumer />
      </ToastProvider>
    )
    act(() => toast!.error('Fehler'))
    const stack = screen.getByText('Fehler').closest('.fixed')
    expect(stack).toHaveClass('bottom-4')
    expect(stack).not.toHaveClass('bottom-16')
  })
})
