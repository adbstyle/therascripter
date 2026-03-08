# Security Architecture

Therascript processes sensitive therapy session data. Every design decision prioritizes patient privacy: all data stays on-device, network access is blocked in production, and Electron's attack surface is reduced through hardened defaults.

## Content Security Policy (CSP)

CSP headers are injected via `session.defaultSession.webRequest.onHeadersReceived` in `src/main/index.ts`.

**Production CSP (strict lockdown):**

```
default-src 'none';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data:;
font-src 'self';
connect-src 'none';
frame-src 'none';
object-src 'none';
base-uri 'none';
form-action 'none';
```

Key directives:

- **`default-src 'none'`** — Blocks everything not explicitly allowed.
- **`connect-src 'none'`** — Zero network access. No XHR, fetch, WebSocket, or EventSource requests can be made from the renderer. This is the backbone of NFR-12 (no cloud communication).
- **`frame-src 'none'`** and **`object-src 'none'`** — No iframes, embeds, or plugins.
- **`base-uri 'none'`** and **`form-action 'none'`** — Prevent base tag injection and form submission attacks.
- **`style-src 'self' 'unsafe-inline'`** — Inline styles are allowed because Tailwind CSS and TipTap generate them at runtime.

**Development CSP** relaxes restrictions for Vite HMR: `script-src` includes `'unsafe-inline'` and `connect-src` allows `ws://localhost:*` for WebSocket hot-reload.

## Electron Fuses

Fuses are compile-time toggles baked into the Electron binary. Once flipped, they cannot be changed at runtime. Therascript configures them in `build-scripts/afterPack.js`:

| Fuse | Value | Purpose |
|------|-------|---------|
| `RunAsNode` | `false` | Prevents using the Electron binary as a generic Node.js runtime via `ELECTRON_RUN_AS_NODE`. Blocks a common privilege escalation vector. |
| `EnableCookieEncryption` | `true` | Encrypts cookie storage on disk using OS-level keychain. |
| `EnableNodeOptionsEnvironmentVariable` | `false` | Ignores `NODE_OPTIONS` environment variable, preventing injection of `--inspect` or `--require` flags. |
| `EnableNodeCliInspectArguments` | `false` | Disables `--inspect` and `--inspect-brk` CLI arguments, preventing remote debugging attachment. |
| `OnlyLoadAppFromAsar` | `true` | Forces the app to load only from the asar archive, preventing code injection via unpacked app directories. |
| `EnableEmbeddedAsarIntegrityValidation` | `false` | Disabled because asar integrity validation requires a proper Apple Developer code signing certificate. |

After flipping fuses, `resetAdHocDarwinSignature: true` re-signs the binary with an ad-hoc signature (`codesign --sign -`). Without this step, macOS would kill the app on launch with `CODESIGNING, Code 2 Invalid Page` because the fuse changes invalidate the original signature.

## Context Isolation and Sandbox

Both are always enabled in the `BrowserWindow` configuration (`src/main/index.ts`):

```typescript
webPreferences: {
  preload: join(__dirname, '../preload/index.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true
}
```

- **`contextIsolation: true`** — The renderer's JavaScript context is completely separated from the preload script's context. The renderer cannot access Node.js APIs or Electron internals directly. All communication goes through the `contextBridge`.
- **`nodeIntegration: false`** — Node.js APIs (`require`, `fs`, `child_process`, etc.) are not available in the renderer process.
- **`sandbox: true`** — The renderer process runs in a Chromium sandbox with restricted OS-level access. Even if an attacker achieves code execution in the renderer, they cannot access the filesystem or spawn processes.

This means all main process functionality is only reachable through explicitly defined IPC channels validated with Zod schemas.

## BrowserWindow Security

### Navigation Blocking

All navigation away from the app is blocked (`src/main/index.ts`):

```typescript
mainWindow.webContents.on('will-navigate', (event, url) => {
  const devURL = process.env['ELECTRON_RENDERER_URL'] || ''
  if (!app.isPackaged && url.startsWith(devURL)) return
  event.preventDefault()
})
```

In production, every navigation attempt is cancelled. In development, only navigation to the Vite dev server URL is permitted. This prevents `file://` protocol attacks and redirection to malicious external pages.

### Popup Denial

New window creation is always denied:

```typescript
mainWindow.webContents.setWindowOpenHandler(({ url }) => {
  if (url.startsWith('https:') || url.startsWith('http:')) {
    shell.openExternal(url)
  }
  return { action: 'deny' }
})
```

If a link targets `_blank` or `window.open()` is called, the window is never created. HTTP/HTTPS URLs are opened in the user's default browser via `shell.openExternal` instead.

## FileVault Check

At startup, `checkFileVaultOnStartup()` in `src/main/services/FileVaultService.ts` runs the macOS `fdesetup status` command to determine whether FileVault disk encryption is active.

If FileVault is **not enabled**, a warning dialog is shown (in German):

> **FileVault nicht aktiv**
>
> Therascript speichert vertrauliche Therapiedaten lokal. Ohne FileVault-Verschluesselung sind diese Daten bei physischem Zugriff auf Ihren Mac ungeschuetzt.

The dialog directs the user to enable FileVault via System Settings. The check is non-blocking — the app continues to function regardless of the result. If `fdesetup` is unavailable or times out (5-second limit), the check is silently skipped.

## Code Signing

Therascript does not use an Apple Developer certificate. The `electron-builder.yml` configuration sets:

```yaml
mac:
  identity: null
```

This tells electron-builder to skip code signing entirely during the build. Instead, `afterPack.js` applies an ad-hoc signature after flipping Electron Fuses:

```javascript
await flipFuses(electronBinary, {
  resetAdHocDarwinSignature: true,
  // ... fuse options
})
```

The ad-hoc signature (`codesign --sign -`) ensures the binary's code pages are valid on ARM64 macOS, which requires all executable code to be signed. Without any signature, Apple Silicon Macs refuse to run the binary.

## Gatekeeper

Because the app uses an ad-hoc signature (not notarized by Apple), macOS Gatekeeper blocks it on first launch. Users must:

1. Right-click the app in Finder
2. Select "Open" from the context menu
3. Confirm the security dialog

This is a one-time action. After the first launch, macOS remembers the user's choice and the app opens normally.

## Preload Security

The preload script (`src/preload/index.ts`) uses `contextBridge.exposeInMainWorld` to expose exactly two objects to the renderer:

- **`window.electron`** — The `@electron-toolkit/preload` API (provides `ipcRenderer.invoke` and `ipcRenderer.on` wrappers).
- **`window.api`** — A structured API object with namespaced methods for each domain.

The `api` object exposes these namespaces:

| Namespace | Methods |
|-----------|---------|
| `sessions` | `list`, `delete`, `rename` |
| `recording` | `start`, `stop`, `sendData`, `onDuration`, `onError`, `onAutoStopped` |
| `settings` | `get`, `set` |
| `tasks` | `getSessionTasks`, `isProcessing`, `onProgress`, `onCompleted`, `onError` |
| `blocklist` | `list`, `add`, `update`, `delete` |
| `import` | `pdf`, `showPDFDialog`, `getPathForFile` |
| `review` | `load`, `save`, `exportClipboard` |
| `system` | `aboutInfo`, `uninstall`, `openInFinder` |
| `modelDownload` | `status`, `checkDiskSpace`, `start`, `onStatus` |
| `modelUpdate` | `check`, `restart`, `startDownload`, `getPending`, `clearPending`, `onAvailable`, `onDownloadProgress`, `onDownloadComplete`, `onDownloadError` |
| `appUpdate` | `getStatus`, `check`, `openReleasePage`, `onStatus` |

Each method maps to a single `ipcRenderer.invoke` or `ipcRenderer.send` call with a specific channel name. The renderer has no access to arbitrary IPC channels, `require()`, or any Node.js API. Event listeners return unsubscribe functions to prevent memory leaks.

All IPC channels use Zod schema validation on the main process side (schemas in `src/shared/validation/`) to reject malformed payloads before they reach handler logic.

## Additional Measures

- **Spotlight exclusion** — `ensureSpotlightExclusion()` runs at startup to prevent macOS Spotlight from indexing the app's data directory (`~/.therascript/`), keeping session content out of system-wide search.
- **Auto-deletion** — Sessions are automatically deleted 30 days after creation, reducing the window of exposure for stored patient data.
- **App category** — Registered as `public.app-category.medical` in `electron-builder.yml`, signaling to macOS that the app handles sensitive health data.
