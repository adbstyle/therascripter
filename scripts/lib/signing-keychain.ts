/**
 * Zugriff auf die privaten Signaturschlüssel im Anmelde-Schlüsselbund des
 * Release-Macs (Issue #163, NFR 1). Ein Schlüssel liegt als Base64 von
 * PKCS8-DER — einzeilig, weil `security -w` mehrzeilige Passwörter hex-kodiert
 * ausgibt.
 *
 * Zwei Einträge:
 *   - CURRENT: signiert jeden Release
 *   - NEXT: Nachfolger während eines Schlüsselwechsels — die App vertraut ihm
 *     schon, signiert wird erst nach `generate-signing-keys.ts --activate-next`
 *
 * Beim ersten Lesen fragt macOS einmal; mit «Immer erlauben» signiert jeder
 * weitere Release ohne Rückfrage (AK 3). Lesen kann den Eintrag nur ein
 * Prozess unter dem Konto des Herausgebers — nichts davon gelangt in Repo,
 * .env oder App-Paket (AK 7).
 */
import { execFileSync } from 'child_process'

export const KEYCHAIN_ACCOUNT = 'therascript'
export const KEYCHAIN_CURRENT = 'therascript-update-signing'
export const KEYCHAIN_NEXT = 'therascript-update-signing-next'

export function readKeychainKey(service: string): string | null {
  try {
    return execFileSync(
      'security',
      ['find-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', service, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim()
  } catch {
    return null
  }
}

export function readSigningKeyFromKeychain(): string {
  const key = readKeychainKey(KEYCHAIN_CURRENT)
  if (!key) {
    throw new Error(
      `Kein Signaturschlüssel im Schlüsselbund (Dienst «${KEYCHAIN_CURRENT}»). ` +
        'Einmalig erzeugen: npx tsx scripts/generate-signing-keys.ts'
    )
  }
  return key
}

/** Schreibt oder ersetzt (-U) einen Schlüssel — ein abgebrochener Lauf lässt sich wiederholen. */
export function storeKeychainKey(service: string, label: string, privateKeyBase64: string): void {
  execFileSync('security', [
    'add-generic-password',
    '-U',
    '-a',
    KEYCHAIN_ACCOUNT,
    '-s',
    service,
    '-l',
    label,
    '-w',
    privateKeyBase64
  ])
}

export function deleteKeychainKey(service: string): void {
  execFileSync('security', ['delete-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', service], {
    stdio: 'ignore'
  })
}
