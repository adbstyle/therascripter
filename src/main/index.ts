import { app, BrowserWindow, dialog, session, shell } from 'electron'
import { join } from 'path'
import { initDatabase, closeDatabase } from './db/connection'

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1024,
    height: 700,
    minWidth: 800,
    minHeight: 600,
    title: 'Therascript',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 10 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // Block navigation away from the app (prevents file:// and external URL attacks)
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devURL = process.env['ELECTRON_RENDERER_URL'] || ''
    if (!app.isPackaged && url.startsWith(devURL)) return
    event.preventDefault()
  })

  // Block new window creation, open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:') || url.startsWith('http:')) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  // Load renderer
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function setupCSP(): void {
  const isDev = !app.isPackaged
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    // Dev: 'unsafe-inline' + ws: required for Vite HMR hot-reload
    // Prod: strict lockdown per NFR-12 (connect-src 'none' = no network)
    const csp = isDev
      ? "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws://localhost:*;"
      : "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';"

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp]
      }
    })
  })
}

app.whenReady().then(() => {
  try {
    initDatabase()
  } catch (error) {
    dialog.showErrorBox(
      'Therascript – Datenbankfehler',
      `Die Datenbank konnte nicht geöffnet werden.\n\n${error instanceof Error ? error.message : String(error)}`
    )
    app.quit()
    return
  }

  setupCSP()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  // On macOS, keep app running when all windows are closed
  // (standard macOS behavior — re-open via Dock or Tray)
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('quit', () => {
  closeDatabase()
})
