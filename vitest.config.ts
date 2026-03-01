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
    pool: 'threads',
    poolOptions: {
      threads: {
        maxThreads: 2
      }
    }
  }
})
