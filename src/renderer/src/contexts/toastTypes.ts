import { createContext } from 'react'

export interface ToastOptions {
  /** Anzeigedauer; Standard 3 s. Längere Hinweise, die der USER lesen muss, länger. */
  durationMs?: number
}

export interface ToastContextValue {
  success: (message: string, options?: ToastOptions) => void
  error: (message: string, options?: ToastOptions) => void
}

export const ToastContext = createContext<ToastContextValue | null>(null)
