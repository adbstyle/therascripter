# Settings

The Settings view provides four tabs: **Sperrliste**, **Darstellung**, **Modelle**, and **Über**. It is implemented in `src/renderer/src/views/Settings.tsx`.

## Navigation

The sidebar in `App.tsx` contains a persistent "Einstellungen" button that sets `currentView` to `'settings'`, rendering the `<Settings />` component. The sidebar buttons are disabled during recording (`isRecording`) and while in review (`currentView === 'review'`). There is no separate back button — the user navigates back by clicking "Sitzungen" in the sidebar.

The header displays "Einstellungen" as the title when the settings view is active.

## Tabs

The `Settings` component manages a local `currentTab` state of type `'sperrliste' | 'darstellung' | 'modelle' | 'ueber'`. Tabs are rendered as a horizontal nav bar with underline-style active indicator. The default tab on mount is `sperrliste`.

### Sperrliste (Blocklist)

Renders the `<BlocklistManager />` component. Provides full CRUD management of blocklist entries with 7 entity types: PERSON, ORT, DATUM, KONTAKT, ORGANISATION, MEDIZINISCH, SONSTIGES. Each entry has a term, a placeholder type, and a creation date. Entries are stored in better-sqlite3 and accessed via `window.api.blocklist.*` IPC calls.

See `src/renderer/src/components/BlocklistManager.tsx`.

### Darstellung (Appearance)

Renders the `<AppearanceSettings />` component. Currently contains a single setting: the theme toggle.

Three theme options are displayed as selectable cards in a horizontal row:

| Option | Label | Description |
|--------|-------|-------------|
| `light` | Hell | Immer heller Modus |
| `system` | System | Folgt der macOS-Einstellung |
| `dark` | Dunkel | Immer dunkler Modus |

The selected option is highlighted with a primary-colored border and background. Clicking a card calls `setTheme(option.id)` from the `useTheme` hook.

### Modelle (Models)

Placeholder tab — not yet implemented. Displays the text "Modell-Verwaltung — noch nicht implementiert" centered in the content area.

### Über (About)

Renders the `<AboutPage />` component. Sections displayed top to bottom:

1. **App logo and version** — `Therascript v{version}` with "Open Source (MIT-Lizenz)" subtitle.
2. **App update check** — "Nach Updates suchen" button triggers `checkNow()` from `useAppUpdate`. While checking, button text changes to "Prüfe...". If an update is available, a "Neue Version verfügbar — herunterladen" link appears that calls `openReleasePage()` (opens GitHub Releases in browser). If up-to-date, shows "Therascript ist aktuell".
3. **Local processing note** — "Alle Verarbeitung findet komplett lokal auf Ihrem Mac statt."
4. **Source code** — "Auf GitHub ansehen" button opens the GitHub repository.
5. **App data directory** — Shows `~/.therascript` path with an "Öffnen" button that reveals it in Finder via `window.api.system.openInFinder()`.
6. **Storage usage** — Displays "App + Modelle" and "Sitzungsdaten" sizes formatted via `formatBytes()`.
7. **System info** — macOS version, chip, RAM (GB), FileVault status (active / not active / unknown).
8. **Data retention notice** — Info box explaining 30-day auto-deletion and user responsibility for exported text.
9. **Acknowledgments** — Lists key open-source dependencies: Whisper.cpp, pyannote.audio, flair, TipTap, Electron, pdfjs-dist, better-sqlite3.
10. **Uninstall** — "Therascript vollständig entfernen" button shows a `ConfirmDialog` listing what will be deleted (ML models, sessions, audio files, blocklist, settings). On confirm, calls `window.api.system.uninstall()`.

The about info is fetched once on mount via `window.api.system.aboutInfo()` which returns an `AboutInfo` object containing `version`, `dataDir`, `storageModelsBytes`, `storageSessionsBytes`, `osVersion`, `chip`, `totalMemoryGB`, and `fileVaultActive`.

## Theme System

### Architecture

The theme system spans three Electron processes:

1. **Main process** — Reads the saved `theme` setting at startup and sets `nativeTheme.themeSource` accordingly (`'light'`, `'dark'`, or `'system'`). When `createWindow()` runs, it checks `nativeTheme.themeSource` and `nativeTheme.shouldUseDarkColors` to compute a `backgroundColor` for the `BrowserWindow` (`#0f1117` for dark, `#ffffff` for light). This prevents a white flash when launching in dark mode.

2. **Preload/IPC** — `settings-handlers.ts` registers `settings:get` and `settings:set` IPC handlers. When the `theme` key is written, the handler also syncs `nativeTheme.themeSource` so native OS dialogs and future windows match.

3. **Renderer** — `ThemeProvider` (in `src/renderer/src/contexts/ThemeContext.tsx`) manages theme state:
   - On mount, reads the saved preference via `window.api.settings.get('theme')`.
   - Calls `applyTheme()` which toggles the `dark` CSS class on `document.documentElement` based on preference and `prefers-color-scheme` media query.
   - Listens for system theme changes via `matchMedia('(prefers-color-scheme: dark)')` — only acts when preference is `'system'`.
   - `setTheme()` updates local state, applies the CSS class, and persists via `window.api.settings.set('theme', preference)`.

### Type

`ThemePreference` is defined in `src/shared/types/index.ts` as `'light' | 'system' | 'dark'`.

### Context

`ThemeContext` is created in `src/renderer/src/contexts/themeTypes.ts` with a `ThemeContextValue` interface providing `theme` (current preference) and `setTheme` (setter). Components access it via the `useTheme` hook.

## App Update Indicator in Sidebar

When `appUpdateStatus?.available` is true, the sidebar bottom shows a clickable "Update verfügbar" hint (primary color) that calls `openReleasePage()`. Otherwise, it shows the current app version prefixed with a lock icon.

## electron-store Keys

All settings are persisted via `electron-store` in `SettingsService.ts`. The store file is named `settings.json`.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `activeModels.transcription` | `string` | `'whisper-large-v3-turbo'` | Active ASR model identifier |
| `activeModels.diarization` | `string` | `'pyannote-community-1'` | Active diarization model identifier |
| `activeModels.ner` | `string` | `'flair-ner-german-large'` | Active NER model identifier |
| `activeModels.ocr` | `string` | `'apple-vision'` | Active OCR model identifier |
| `firstLaunchDone` | `boolean` | `false` | Whether first-launch flow has completed |
| `consentReminderShown` | `boolean` | `false` | Whether the recording consent reminder was shown |
| `modelsDownloaded` | `boolean` | `false` | Whether all ML models have been downloaded |
| `theme` | `ThemePreference` | `'system'` | Theme preference: `'light'`, `'system'`, or `'dark'` |
| `installedModelVersions` | `Record<string, InstalledModelVersion>` | `{}` | Tracks installed version info per model |
| `pendingModelUpdates` | `PendingModelUpdate[] \| null` | `null` | Staged model updates to apply on next restart |
| `cachedAppUpdateStatus` | `AppUpdateStatus \| null` | `null` | Last known app update check result |

## Key Source Files

- `src/renderer/src/views/Settings.tsx` — Tab container
- `src/renderer/src/components/AppearanceSettings.tsx` — Theme toggle UI
- `src/renderer/src/components/AboutPage.tsx` — About tab content
- `src/renderer/src/components/BlocklistManager.tsx` — Blocklist CRUD UI
- `src/renderer/src/contexts/ThemeContext.tsx` — ThemeProvider
- `src/renderer/src/contexts/themeTypes.ts` — ThemeContext and ThemePreference type
- `src/renderer/src/hooks/useAppUpdate.ts` — App update status hook
- `src/main/services/SettingsService.ts` — electron-store schema and defaults
- `src/main/ipc/settings-handlers.ts` — IPC handlers with nativeTheme sync
- `src/main/index.ts` — Startup theme sync and BrowserWindow backgroundColor
