import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'

export default tseslint.config(
  {
    ignores: [
      'out',
      'dist',
      'node_modules',
      '*.config.*',
      // Nicht-App-Code: Python-Umgebungen, Build-Scratch, Standalone-Tools
      'python_sidecar',
      'build',
      'build-scripts',
      'figma-plugin',
      'swift_cli',
      'website',
      'r2-upload',
      '.playwright-mcp',
      // Worktrees paralleler Claude-Sessions: eigene Checkouts, nicht Teil dieses Trees
      '.claude'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Node-Skripte (Release-Tooling, CDP-E2E gegen die gepackte App): ohne
    // diese Globals meldete ESLint console/process/Buffer/fetch als undefiniert.
    // WebSocket ist seit Node 22 global, globals@14 kennt es noch nicht.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node, WebSocket: 'readonly' }
    }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }]
    }
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ]
    }
  }
)
