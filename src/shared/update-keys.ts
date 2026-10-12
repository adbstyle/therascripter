/**
 * Öffentliche Schlüssel für die signierte Update-Beschreibung (manifest.json,
 * ADR-009 Entscheidung 3, Issue #163). Die App prüft eine Signatur gegen jeden
 * Schlüssel dieser Liste (#164, #167).
 *
 * Zwei Schlüssel, damit ein Wechsel ohne Neuinstallation geht (AK 5):
 *   - primary: liegt im Schlüsselbund des Release-Macs, signiert jeden Release
 *   - backup: liegt offline beim Herausgeber, signiert nur nach Verlust des
 *     Hauptschlüssels; die nächste Version bringt dann ein neues Paar mit
 * Ein Schlüssel wird erst aus dieser Liste entfernt, wenn kaum noch
 * Installationen eine Version ohne seinen Nachfolger haben.
 *
 * Erzeugt von scripts/generate-signing-keys.ts. Format: SPKI-DER als Base64.
 */
export interface UpdateSigningKey {
  keyId: string
  publicKey: string
}

export const UPDATE_SIGNING_KEYS: readonly UpdateSigningKey[] = [
  {
    keyId: 'primary-2026-10',
    publicKey: 'MCowBQYDK2VwAyEAs0yWpmhSjVwRQfbJcREMn0Xq1x5zjM9mVbDXY9Vh6Ak='
  },
  {
    keyId: 'backup-2026-10',
    publicKey: 'MCowBQYDK2VwAyEAniQP4ZfoOzu/a1gXOg+HWpn8zJA/2C/6jirMoL7g5ZM='
  }
]

/**
 * Pfad der Signatur relativ zum Manifest. Der Name enthält den SHA-256 des
 * Manifests: Eine App, die das Manifest während eines Uploads abruft, bekommt
 * nie die Signatur eines anderen Stands — sie fragt genau die Signatur zu den
 * Bytes, die sie hat.
 */
export function manifestSignaturePath(manifestSha256: string): string {
  return `signatures/${manifestSha256}.json`
}
