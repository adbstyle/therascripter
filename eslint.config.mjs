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
    // Node-Skripte (Release-Tooling, CDP-E2E gegen die gepackte App, Build-Hooks):
    // ohne diese Globals meldet ESLint console/process/Buffer/fetch als undefiniert.
    files: ['scripts/**/*.{js,mjs,cjs}', 'build-scripts/**/*.js'],
    languageOptions: {
      globals: globals.node
    }
  },
  {
    // electron-builder lädt die Build-Hooks (afterPack, afterAllArtifactBuild)
    // per require() — sie sind CommonJS.
    files: ['build-scripts/**/*.js', 'scripts/**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' }
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
