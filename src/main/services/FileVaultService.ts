import { execSync } from 'child_process'
import { dialog } from 'electron'

export function checkFileVaultOnStartup(): void {
  try {
    const output = execSync('fdesetup status', { encoding: 'utf-8', timeout: 5000 })
    const isEnabled = output.includes('FileVault is On')

    if (!isEnabled) {
      dialog.showMessageBox({
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
  } catch {
    // fdesetup not available or timed out — skip silently
  }
}
