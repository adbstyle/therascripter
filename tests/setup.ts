import '@testing-library/jest-dom/vitest'

// jsdom implementiert window.matchMedia nicht — ThemeProvider (applyTheme)
// braucht es beim Mount. Minimaler Stub mit modernem Listener-API.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false
    }) as MediaQueryList
}
