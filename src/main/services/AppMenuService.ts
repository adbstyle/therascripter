import { app, Menu } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'

interface InitOptions {
  onOpenSettings: () => void
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
        { role: 'togglefullscreen', label: 'Vollbild' }
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
