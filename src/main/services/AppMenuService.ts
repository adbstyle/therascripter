import { app, Menu } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'

interface InitOptions {
  onOpenSettings: () => void
}

// Builds the macOS Application Menu with standard sub-menus plus
// "Einstellungen…" (⌘,) routed to the Settings overview and
// "Therascript beenden" (⌘Q) using the standard quit role.
//
// Application-menu accelerators only fire when Therascript is the focused
// app — this is exactly what AC #10 requires.
export function initAppMenu({ onOpenSettings }: InitOptions): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
    return
  }

  const appName = app.getName()

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
        {
          label: `${appName} beenden`,
          accelerator: 'CommandOrControl+Q',
          role: 'quit'
        }
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
