/**
 * Zugriff auf den privaten Signaturschlüssel im Anmelde-Schlüsselbund des
 * Release-Macs (Issue #163, NFR 1). Der Schlüssel liegt als Base64 von
 * PKCS8-DER — einzeilig, weil `security -w` mehrzeilige Passwörter hex-kodiert
 * ausgibt.
 *
 * Beim ersten Lesen fragt macOS einmal; mit «Immer erlauben» signiert jeder
 * weitere Release ohne Rückfrage (AK 3). Lesen kann den Eintrag nur ein
 * Prozess unter dem Konto des Herausgebers — nichts davon gelangt in Repo,
 * .env oder App-Paket (AK 7).
 */
import { execFileSync } from 'child_process'

export const KEYCHAIN_SERVICE = 'therascript-update-signing'
export const KEYCHAIN_ACCOUNT = 'therascript'

export function readSigningKeyFromKeychain(): string {
  try {
    return execFileSync(
      'security',
      ['find-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', KEYCHAIN_SERVICE, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim()
  } catch {
    throw new Error(
      `Kein Signaturschlüssel im Schlüsselbund (Dienst «${KEYCHAIN_SERVICE}»). ` +
        'Einmalig erzeugen: npx tsx scripts/generate-signing-keys.ts'
    )
  }
}

export function storeSigningKeyInKeychain(privateKeyBase64: string): void {
  execFileSync('security', [
    'add-generic-password',
    '-a',
    KEYCHAIN_ACCOUNT,
    '-s',
    KEYCHAIN_SERVICE,
    '-l',
    'Therascript Update-Signatur (Hauptschlüssel)',
    '-w',
    privateKeyBase64
  ])
}
