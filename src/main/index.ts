import { app, BrowserWindow, dialog, nativeTheme, Notification, session, shell } from 'electron'
import { join } from 'path'
import { initDatabase, getDatabase, closeDatabase } from './db/connection'
import { initSettings, getSettings } from './services/SettingsService'
import { initTaskQueue, getTaskQueue } from './services/TaskQueueService'
import { registerSessionHandlers } from './ipc/session-handlers'
import {
  registerRecordingHandlers,
  cleanupRecordingOnQuit,
  stopRecordingFromTray,
  recoverCrashedRecordings
} from './ipc/recording-handlers'
import { registerSettingsHandlers } from './ipc/settings-handlers'
import { registerMicrophoneHandlers } from './ipc/microphone-handlers'
import { initToolHealth, registerToolHealthHandlers } from './ipc/tool-health-handlers'
import { registerTaskHandlers } from './ipc/task-handlers'
import { registerBlocklistHandlers } from './ipc/blocklist-handlers'
import { registerPDFHandlers } from './ipc/pdf-handlers'
import { registerReviewHandlers } from './ipc/review-handlers'
import { registerSystemHandlers } from './ipc/system-handlers'
import { registerModelDownloadHandlers } from './ipc/model-download-handlers'
import { registerModelCatalogHandlers } from './ipc/model-catalog-handlers'
import { registerModelReconcileHandlers } from './ipc/model-reconcile-handlers'
import { registerPipelineHandlers } from './ipc/pipeline-handlers'
import { initTray, getTray } from './services/TrayService'
import { initAppMenu } from './services/AppMenuService'
import { sendToRenderer } from './utils/ipc-helpers'
import {
  startAutoDeletion,
  stopAutoDeletion,
  ensureSpotlightExclusion
} from './services/AutoDeletionService'
import { checkFileVaultOnStartup } from './services/FileVaultService'
import { backfillAnonymizationCounts } from './services/AnonymizationCountBackfillService'
import { registerAppUpdateHandlers } from './ipc/app-update-handlers'
import { getAppUpdateService, initAppUpdateService } from './services/app-update-deps'
import {
  cleanupIncompleteUpdates,
  migrateInstalledVersions,
  checkForUpdates
} from './services/UpdateCheckService'
import { sweepStaleArtifactsAtStartup } from './services/StartupCleanupService'
import { WhisperService } from './ml/WhisperService'
import { PyannoteSidecar } from './ml/PyannoteSidecar'
import { AlignmentService } from './ml/AlignmentService'
import { AnonymizationService } from './ml/AnonymizationService'
import { PDFExtractionExecutor } from './services/PDFExtractionExecutor'
import { VisionOCRService } from './ml/VisionOCRService'
import { LlamaSummarizer } from './ml/LlamaSummarizer'
import { SummarizationExecutor } from './ml/SummarizationExecutor'
import { SessionService } from './services/SessionService'
import {
  getActiveModelPath,
  getActiveModelId,
  getModelsDir,
  reconcileActiveModels,
  retireObsoleteModels
} from './services/ModelDownloadService'
import { registerSummaryHandlers } from './ipc/summary-handlers'
import { startToolCheck } from './services/ToolHealthService'

// Set in before-quit so the close-handler can distinguish "user closed window"
// (hide) from "app is shutting down" (allow destroy).
let isQuitting = false

// Issue #164 — nach einem Update-Neustart bleibt ein vorher verstecktes
// Fenster versteckt (Datenschutz: keine Sitzungstitel auf dem Bildschirm,
// während niemand davor sitzt). macOS meldet beim Start ein 'activate', das
// das Fenster sonst sofort zeigen würde.
let suppressActivateUntil = 0

function showBackgroundReminderOnce(): void {
  const settings = getSettings()
  if (settings.get('backgroundReminderShown')) return
  if (!Notification.isSupported()) return

  new Notification({
    title: 'TheraScript läuft im Hintergrund',
    body: 'Über das Symbol in der Menüleiste kannst du das Fenster wieder anzeigen oder die App beenden.',
    silent: true
  }).show()

  settings.set('backgroundReminderShown', true)
}

function createWindow(): void {
  const startHidden = getSettings().get('startHiddenAfterUpdate') === true
  if (startHidden) {
    getSettings().set('startHiddenAfterUpdate', false)
    suppressActivateUntil = Date.now() + 5_000
  }

  // Set background color based on theme to prevent white flash in dark mode
  const isDark =
    nativeTheme.themeSource === 'dark' ||
    (nativeTheme.themeSource === 'system' && nativeTheme.shouldUseDarkColors)

  const mainWindow = new BrowserWindow({
    width: 1024,
    height: 700,
    minWidth: 800,
    minHeight: 600,
    title: 'TheraScript',
    show: !startHidden,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 11 },
    backgroundColor: isDark ? '#0f1117' : '#ffffff',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // macOS tray-app behavior: red traffic-light hides the window instead of
  // destroying it, so the tray "Fenster anzeigen" handler can bring it back
  // and the renderer state (review editor, scroll position) survives.
  // On first hide, post a one-shot system notification so the user knows
  // the app keeps running.
  mainWindow.on('close', (event) => {
    if (isQuitting) return
    if (process.platform !== 'darwin') return
    event.preventDefault()
    mainWindow.hide()
    showBackgroundReminderOnce()
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

// Last-Resort-Handler: mehrere Main-Throws passieren in Event-Callbacks
// außerhalb von IPC-Invokes (Stream-finish-Handler, Recording-Writes) — ohne
// diese Handler crasht Electron kommentarlos und die DB bleibt ohne
// WAL-Checkpoint zurück.
process.on('uncaughtException', (error) => {
  console.error('[Main] Uncaught exception:', error)
  try {
    closeDatabase()
  } catch {
    // DB war ggf. nie offen
  }
  try {
    dialog.showErrorBox(
      'Unerwarteter Fehler',
      `Therascript ist auf einen unerwarteten Fehler gestoßen und wird beendet.\n\n${error.message}`
    )
  } catch {
    // Dialog kann vor app.whenReady fehlschlagen
  }
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  // Nur loggen — eine unbehandelte Rejection ist kein Grund, die App (und
  // damit ggf. eine laufende Aufnahme) zu beenden.
  console.error('[Main] Unhandled rejection:', reason)
})

app.whenReady().then(() => {
  try {
    initDatabase()
  } catch (error) {
    dialog.showErrorBox(
      'TheraScript – Datenbankfehler',
      `Die Datenbank konnte nicht geöffnet werden.\n\n${error instanceof Error ? error.message : String(error)}`
    )
    app.quit()
    return
  }

  initSettings()

  // Sync Electron nativeTheme with saved preference
  const savedTheme = getSettings().get('theme') as string | undefined
  if (savedTheme === 'light' || savedTheme === 'dark') {
    nativeTheme.themeSource = savedTheme
  } else {
    nativeTheme.themeSource = 'system'
  }

  // Altlast des Modell-Update-Ablaufs vor #167 (models/.staging, .backup)
  cleanupIncompleteUpdates()

  // Migrate existing model installations to version tracking (one-time,
  // idempotent). Vor dem Update-Start: der trägt nach einem gelungenen
  // Update neue Modell-Fassungen ein — danach sähe die Migration einen
  // nicht leeren Stand und überginge den Altbestand.
  migrateInstalledVersions()

  // Issues #164/#167 — Update aus App und Modellen: Ergebnis eines
  // Austauschs auswerten, Reste aufräumen, ein bereitliegendes Update wieder
  // anbieten. Die Menüleiste entsteht erst später, deshalb defensiv.
  initAppUpdateService((state) => {
    try {
      getTray().setUpdateReady(state.phase === 'ready' ? { version: state.version } : null)
    } catch {
      // Tray noch nicht initialisiert — initTray liest den Zustand selbst
    }
  })

  // Delete models dropped from the catalog (e.g. Gemma 3) and clear their
  // slot BEFORE the reconciler — it would otherwise report them as missing.
  retireObsoleteModels()

  // Issue #84 / Story C — verify the invariant that every active-model slot
  // either points at an installed catalog model or is null. Heals stale slots
  // (e.g. a model the user deleted in Finder) before any executor or the
  // FirstLaunchScreen reads them. Skipped on a truly-fresh install — see
  // reconcileActiveModels().
  reconcileActiveModels()

  // Initialize task queue + crash recovery (before IPC handlers that may enqueue tasks)
  const taskQueue = initTaskQueue(getDatabase())
  const recovered = taskQueue.recoverStuckTasks()
  if (recovered > 0) {
    console.log(`Task Queue: ${recovered} stuck task(s) reset to pending`)
  }
  const orphaned = taskQueue.recoverOrphanedSessions()
  if (orphaned > 0) {
    console.log(`Task Queue: ${orphaned} orphaned session(s) marked as error`)
  }

  // Issue #168 — Werkzeuge, die macOS blockiert, erkennen und (bei erteilter
  // Programm-Freigabe) still beheben. Läuft im Hintergrund (~0.1 s, nur die
  // ~600 Programmdateien); die Oberfläche wartet nicht, nur die Verarbeitung —
  // sonst scheiterte die erste Aufgabe an einem Werkzeug, das gleich repariert
  // wird. Höchstens 10 s, danach läuft die Verarbeitung trotzdem an.
  startToolCheck(initToolHealth(), taskQueue)

  // Register real ML executors (replacing stubs)
  taskQueue.registerExecutor('transcription', new WhisperService())
  taskQueue.registerExecutor('diarization', new PyannoteSidecar())
  taskQueue.registerExecutor('alignment', new AlignmentService())
  taskQueue.registerExecutor('anonymization', new AnonymizationService())
  taskQueue.registerExecutor('extraction', new PDFExtractionExecutor())
  taskQueue.registerExecutor('ocr', new VisionOCRService())

  const llamaSummarizer = new LlamaSummarizer({
    getModelPath: () => {
      const path = getActiveModelPath('summarization')
      if (path === null) {
        // The SummarizationExecutor checks isModelInstalled() before reaching
        // summarize(), so this throw is a defensive belt: it would only fire
        // on a race where the model is deleted between the gate and the
        // subprocess launch. Caught by SummarizationExecutor's try/catch and
        // logged; session reaches review with summary=NULL.
        throw new Error('Summarization-Modell ist nicht aktiv')
      }
      return path
    },
    getBinaryPath: () =>
      app.isPackaged
        ? join(process.resourcesPath, 'llama', 'bin', 'llama-cli')
        : join(app.getAppPath(), 'resources', 'llama', 'bin', 'llama-cli'),
    getAllowedModelsDir: () => join(getModelsDir(), 'summarization')
  })
  const sessionService = new SessionService(getDatabase())
  taskQueue.registerExecutor(
    'summarization',
    new SummarizationExecutor({
      llamaSummarizer,
      sessionService,
      // Both checks delegate to getActiveModelId, which returns null whenever
      // the slot is empty / unknown / file-missing — see ModelDownloadService.
      isModelInstalled: () => getActiveModelId('summarization') !== null,
      getActiveModelId: () => getActiveModelId('summarization'),
      logger: { info: (msg): void => console.log(msg), error: (msg): void => console.error(msg) }
    })
  )

  ensureSpotlightExclusion()

  registerSessionHandlers()
  registerRecordingHandlers()
  registerSettingsHandlers()
  registerTaskHandlers()
  registerBlocklistHandlers()
  registerPDFHandlers()
  registerReviewHandlers()
  registerSystemHandlers()
  registerModelDownloadHandlers()
  registerModelCatalogHandlers()
  registerModelReconcileHandlers()
  registerPipelineHandlers()
  registerAppUpdateHandlers()
  registerMicrophoneHandlers()
  registerToolHealthHandlers()
  registerSummaryHandlers({
    sessionService,
    summaries: {
      missingReason: (id) => getTaskQueue().summaryMissingReason(id),
      regenerate: (id) => getTaskQueue().regenerateSummary(id)
    }
  })

  setupCSP()
  createWindow()
  checkFileVaultOnStartup()

  // FS-lastige One-Shots NACH der Window-Erstellung (beide idempotent und
  // nicht paint-kritisch): der Legacy-Backfill liest potenziell jede
  // anonymisierte TipTap-Datei, der PHI-Sweep walkt das Datenverzeichnis —
  // vor createWindow() verzögerten sie den ersten Paint unbounded.
  setImmediate(() => {
    try {
      const backfilled = backfillAnonymizationCounts(getDatabase())
      if (backfilled > 0) {
        console.log(`Anonymization-count backfill: updated ${backfilled} legacy session(s)`)
      }
    } catch (error) {
      console.error('Anonymization-count backfill failed:', error)
    }
    // PHI-Hygiene: gestitchte Speech-WAVs, llama-Prompt-Dateien und verwaiste
    // writeFileAtomic-Tmp-Dateien wegräumen, die ein harter Crash hinterlassen
    // hat (das finally-Cleanup der Services lief dann nie).
    sweepStaleArtifactsAtStartup()
  })

  // Crash-Recovery für Aufnahmen: Sessions, die im 'recording'-Status hängen
  // geblieben sind (App-Crash während Aufnahme), reparieren + Dialog anbieten.
  // Fire-and-forget: darf den Startup nicht blockieren.
  void recoverCrashedRecordings().catch((err) =>
    console.error('[Recovery] recoverCrashedRecordings fehlgeschlagen:', err)
  )

  // Initialize tray after window is created
  const tray = initTray()
  tray.onStop(() => stopRecordingFromTray())
  tray.onOpenSettings(() => sendToRenderer('nav:openSettings'))
  tray.onInstallUpdate(() => getAppUpdateService()?.requestInstall())
  const updateState = getAppUpdateService()?.getState()
  tray.setUpdateReady(updateState?.phase === 'ready' ? { version: updateState.version } : null)

  // Application Menu owns ⌘, (Einstellungen) and ⌘Q (Beenden) so the
  // shortcuts only fire while Therascript is the focused app.
  initAppMenu({
    onOpenSettings: () => {
      tray.showWindow()
      sendToRenderer('nav:openSettings')
    }
  })

  // Start task queue processing
  taskQueue.start()

  // Start auto-deletion (30-day cleanup at startup + every 6h)
  startAutoDeletion()

  // Non-blocking: check for model + app updates on startup
  checkForUpdates().catch(() => {
    /* already handled inside */
  })

  // Alle 4 Stunden: Eine korrigierte Version erreicht so auch eine App, die
  // wochenlang im Hintergrund läuft (Issue #164, PO-Entscheid).
  setInterval(
    () => {
      checkForUpdates().catch(() => {
        /* already handled inside */
      })
    },
    4 * 60 * 60 * 1000
  )

  // Jede Minute: vorgemerkte Installation nachholen, nach 10 Minuten ohne
  // Eingabe selbständig installieren (#164 AK 7)
  setInterval(() => getAppUpdateService()?.tick(), 60 * 1000)

  app.on('activate', () => {
    if (Date.now() < suppressActivateUntil) return
    const windows = BrowserWindow.getAllWindows()
    if (windows.length === 0) {
      createWindow()
      return
    }
    // Window exists but may be hidden (red traffic-light routes through the
    // close handler that calls hide()). Re-surface it via the tray helper so
    // Dock-click behaves the same as the tray "Fenster anzeigen" entry.
    try {
      getTray().showWindow()
    } catch {
      windows[0].show()
      windows[0].focus()
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

// Geordneter Shutdown: den laufenden ML-Subprozess abbrechen und auf das
// Settle des Executors warten, BEVOR die DB geschlossen wird. Vorher
// überlebten whisper/python/llama den App-Exit (reparented, nie gekillt)
// und der Executor schrieb nach closeDatabase() in eine geschlossene DB.
let quitCleanupDone = false
app.on('before-quit', (event) => {
  isQuitting = true
  if (quitCleanupDone) return
  event.preventDefault()
  // Vor cleanupRecordingOnQuit entscheiden: danach wäre eine laufende
  // Aufnahme nicht mehr erkennbar (#164 AK 14)
  const installPlan = getAppUpdateService()?.prepareQuitInstall() ?? null
  void (async () => {
    cleanupRecordingOnQuit()
    stopAutoDeletion()
    try {
      await getTaskQueue().shutdown(8_000)
    } catch {
      // TaskQueue may not have been initialized
    }
    try {
      getTray().destroy()
    } catch {
      // Tray may not have been initialized
    }
    closeDatabase()
    quitCleanupDone = true
    if (installPlan) {
      // Nur Umbenennungen — die neue Version liegt schon geprüft bereit (NFR 5).
      // Danach exit statt quit: Nach dem Umbenennen des eigenen Bundles bricht
      // macOS ein reguläres Beenden ab, der Prozess liefe weiter (am echten
      // Build gemessen). Aufgeräumt ist hier schon alles.
      getAppUpdateService()?.performQuitInstall(installPlan)
      app.exit(0)
      return
    }
    app.quit()
  })()
})
