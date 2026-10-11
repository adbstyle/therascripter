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
})
