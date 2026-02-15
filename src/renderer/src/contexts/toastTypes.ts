import { createContext } from 'react'

export interface ToastContextValue {
  success: (message: string) => void
  error: (message: string) => void
}

export const ToastContext = createContext<ToastContextValue | null>(null)
