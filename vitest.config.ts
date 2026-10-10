import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src')
    }
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', 'out', 'dist'],
    setupFiles: ['./tests/setup.ts'],
    // forks statt threads: better-sqlite3 (natives Addon) segfaultet beim
    // Teardown von worker_threads sporadisch — Exit 139 ohne Testfehler in
    // ~20 % der Läufe (lokal und in CI). Vitest-Doku: "Segfaults and native
    // code errors". Kostet ~2.5 s pro Lauf.
    pool: 'forks',
    poolOptions: {
      forks: {
        maxForks: 2
      }
    }
  }
})
