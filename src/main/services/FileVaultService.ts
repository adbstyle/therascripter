import { execFile } from 'child_process'
import { dialog } from 'electron'

export function checkFileVaultOnStartup(): void {
  // Async (execFile statt execSync): der synchrone Aufruf blockierte den
  // Main-Process-Event-Loop bis zu 5 s — genau während der Renderer lädt
  // und seine ersten IPC-Calls (session:list, review:load) absetzt.
  execFile('fdesetup', ['status'], { encoding: 'utf-8', timeout: 5000 }, (error, stdout) => {
    if (error) {
      // fdesetup not available or timed out — skip silently
      return
    }
    const isEnabled = stdout.includes('FileVault is On')

    if (!isEnabled) {
      void dialog.showMessageBox({
        type: 'warning',
        title: 'FileVault nicht aktiv',
        message: 'FileVault ist auf diesem Mac nicht aktiviert.',
        detail:
          'TheraScript speichert vertrauliche Therapiedaten lokal. ' +
          'Ohne FileVault-Verschlüsselung sind diese Daten bei physischem ' +
          'Zugriff auf Ihren Mac ungeschützt.\n\n' +
          'Aktivieren Sie FileVault unter:\n' +
          'Systemeinstellungen → Datenschutz & Sicherheit → FileVault',
        buttons: ['Verstanden']
      })
    }
  })
}
