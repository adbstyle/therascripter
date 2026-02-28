import { useCallback, useEffect, useRef, useState } from 'react'
import { ThemeContext, type ThemePreference } from './themeTypes'

const isValidTheme = (v: unknown): v is ThemePreference =>
  v === 'light' || v === 'system' || v === 'dark'

function applyTheme(preference: ThemePreference): void {
  const isDark =
    preference === 'dark' ||
    (preference === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  document.documentElement.classList.toggle('dark', isDark)
}

export function ThemeProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [theme, setThemeState] = useState<ThemePreference>('system')
  const [loaded, setLoaded] = useState(false)
  const themeRef = useRef(theme)
  themeRef.current = theme

  // Load saved theme preference on mount
  useEffect(() => {
    window.api.settings
      .get('theme')
      .then((saved) => {
        const preference = isValidTheme(saved) ? saved : 'system'
        setThemeState(preference)
        applyTheme(preference)
      })
      .catch(() => {
        applyTheme('system')
      })
      .finally(() => {
        setLoaded(true)
      })
  }, [])

  // Listen for system theme changes (only relevant when preference is 'system')
  useEffect(() => {
    if (!loaded) return

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (): void => {
      if (themeRef.current === 'system') {
        applyTheme('system')
      }
    }
    mediaQuery.addEventListener('change', handler)
    return () => mediaQuery.removeEventListener('change', handler)
  }, [loaded])

  const setTheme = useCallback((preference: ThemePreference) => {
    setThemeState(preference)
    applyTheme(preference)
    window.api.settings.set('theme', preference).catch(console.error)
  }, [])

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>
}
