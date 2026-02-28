import { useContext } from 'react'
import { ThemeContext, type ThemeContextValue } from '../contexts/themeTypes'

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext)
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider')
  }
  return context
}
