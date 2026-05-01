import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    build: {
      externalizeDeps: {
        exclude: ['electron-store']
      }
    }
  },
  preload: {
    build: {
      // Sandboxed preloads (sandbox: true in src/main/index.ts) cannot
      // require() arbitrary npm packages at runtime — they must be inlined
      // into out/preload/index.js by the bundler. Anything the preload
      // imports needs to be in this exclude list.
      // - @electron-toolkit/preload: pre-existing helper bridge
      // - zod: schema validation for IPC payloads (Issue #80 Phase D)
      externalizeDeps: {
        exclude: ['@electron-toolkit/preload', 'zod']
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
