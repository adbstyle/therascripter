import { createContext } from 'react'
import type { ThemePreference } from '../../../shared/types'

export type { ThemePreference }

export interface ThemeContextValue {
  theme: ThemePreference
  setTheme: (theme: ThemePreference) => void
}

export const ThemeContext = createContext<ThemeContextValue | null>(null)
