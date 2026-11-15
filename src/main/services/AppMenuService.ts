import { app, Menu } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import type { NavCommand } from '../../shared/validation/change-event-schemas'

interface InitOptions {
  onOpenSettings: () => void
  /** Menü «Gehe zu» und «Seitenleiste ein-/ausblenden» (Epic #192). */
  onNavCommand?: (command: NavCommand) => void
  /** Verstecktes App-Fenster zeigen (vor «Suchen …», wie bei den Einstellungen). */
  onShowWindow?: () => void
}

let currentOptions: InitOptions | null = null

// Builds the macOS Application Menu with standard sub-menus plus
// "Einstellungen…" (⌘,) routed to the Settings overview and the standard
// "beenden" quit role. Application-menu accelerators only fire when the
// app is focused, so they don't act as global shortcuts.
//
// On non-darwin we leave Electron's default menu in place so HTML inputs
// retain Cut/Copy/Paste/Undo via the platform's standard Edit menu.
export function initAppMenu(options: InitOptions): void {
  if (process.platform !== 'darwin') return
  currentOptions = options
  rebuild()
}

function rebuild(): void {
  if (!currentOptions) return

  const appName = app.getName()
  const onOpenSettings = currentOptions.onOpenSettings
  const onNavCommand = currentOptions.onNavCommand ?? (() => {})

  const template: MenuItemConstructorOptions[] = [
    {
      label: appName,
      submenu: [
        { role: 'about', label: `Über ${appName}` },
        { type: 'separator' },
        {
          label: 'Einstellungen…',
          accelerator: 'CommandOrControl+,',
          click: () => onOpenSettings()
        },
        { type: 'separator' },
        { role: 'services', label: 'Dienste' },
        { type: 'separator' },
        { role: 'hide', label: `${appName} ausblenden` },
        { role: 'hideOthers', label: 'Andere ausblenden' },
        { role: 'unhide', label: 'Alle einblenden' },
        { type: 'separator' },
        // role: 'quit' provides the ⌘Q accelerator natively.
        { role: 'quit', label: `${appName} beenden` }
      ]
    },
    {
      label: 'Bearbeiten',
      submenu: [
        { role: 'undo', label: 'Widerrufen' },
        { role: 'redo', label: 'Wiederherstellen' },
        { type: 'separator' },
        { role: 'cut', label: 'Ausschneiden' },
        { role: 'copy', label: 'Kopieren' },
        { role: 'paste', label: 'Einsetzen' },
        { role: 'selectAll', label: 'Alles auswählen' }
      ]
    },
    {
      label: 'Darstellung',
      submenu: [
        ...(app.isPackaged
          ? []
          : ([
              { role: 'reload', label: 'Neu laden' },
              { role: 'forceReload', label: 'Hart neu laden' },
              { role: 'toggleDevTools', label: 'Entwicklertools' },
              { type: 'separator' }
            ] as MenuItemConstructorOptions[])),
        {
          // ⌃⌘S statt ⌘B (Prototyp): ⌘B macht im Editor fett (Epic #192)
          label: 'Seitenleiste ein-/ausblenden',
          accelerator: 'Control+Command+S',
          click: () => onNavCommand('toggleSidebar')
        },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Vollbild' }
      ]
    },
    {
      label: 'Gehe zu',
      submenu: [
        {
          // Suchfenster (#209): öffnet und schliesst es, auch mit Fokus im Editor
          label: 'Suchen …',
          accelerator: 'Command+K',
          click: () => {
            currentOptions?.onShowWindow?.()
            onNavCommand('search')
          }
        },
        { type: 'separator' },
        {
          label: 'Zurück',
          accelerator: 'Command+[',
          click: () => onNavCommand('back')
        },
        {
          label: 'Vorwärts',
          accelerator: 'Command+]',
          click: () => onNavCommand('forward')
        }
      ]
    },
    {
      label: 'Fenster',
      role: 'windowMenu',
      submenu: [
        { role: 'minimize', label: 'Minimieren' },
        { role: 'zoom', label: 'Zoomen' },
        { type: 'separator' },
        { role: 'front', label: 'Alle nach vorne' }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
