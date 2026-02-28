import { createContext } from 'react'

export type ThemePreference = 'light' | 'system' | 'dark'

export interface ThemeContextValue {
  theme: ThemePreference
  setTheme: (theme: ThemePreference) => void
}

export const ThemeContext = createContext<ThemeContextValue | null>(null)
