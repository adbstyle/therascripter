#!/usr/bin/env -S npx tsx
/**
 * Erzeugt einmalig die Signaturschlüssel der Update-Beschreibung (Issue #163):
 *
 *   npx tsx scripts/generate-signing-keys.ts
 *
 * - Hauptschlüssel: privat in den Schlüsselbund des Release-Macs
 *   (scripts/lib/signing-keychain.ts), signiert jeden Release
 * - Reserveschlüssel: privat in eine Datei auf dem Schreibtisch — sofort in
 *   den Passwort-Manager übernehmen und die Datei löschen. Er signiert nur,
 *   wenn der Hauptschlüssel verloren ist (AK 5).
 * - Beide öffentlichen Schlüssel schreibt das Skript nach
 *   src/shared/update-keys.ts — die App vertraut genau diesen.
 *
 * Kein privater Schlüssel erscheint auf der Konsole. Bricht ab, wenn schon
 * Schlüssel eingetragen sind (Wechsel: docs/product/operations/release.md).
 */
import { generateKeyPairSync } from 'crypto'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { publicKeyFromPrivate } from '../src/main/services/ManifestSignature'
import { UPDATE_SIGNING_KEYS } from '../src/shared/update-keys'
import { storeSigningKeyInKeychain } from './lib/signing-keychain'

const KEYS_FILE = join(__dirname, '..', 'src', 'shared', 'update-keys.ts')

function newKey(): { privateKey: string; publicKey: string } {
  const { privateKey } = generateKeyPairSync('ed25519')
  const der = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
  return { privateKey: der, publicKey: publicKeyFromPrivate(der) }
}

if (UPDATE_SIGNING_KEYS.length > 0) {
  console.error('src/shared/update-keys.ts enthält schon Schlüssel — abgebrochen.')
  console.error('Für einen Wechsel siehe docs/product/operations/release.md «Signaturschlüssel».')
  process.exit(1)
}

const generation = new Date().toISOString().slice(0, 7)
const primary = { keyId: `primary-${generation}`, ...newKey() }
const backup = { keyId: `backup-${generation}`, ...newKey() }

const backupFile = join(homedir(), 'Desktop', `therascript-update-signing-${backup.keyId}.txt`)
if (existsSync(backupFile)) {
  console.error(`${backupFile} existiert schon — abgebrochen.`)
  process.exit(1)
}

storeSigningKeyInKeychain(primary.privateKey)
writeFileSync(
  backupFile,
  [
    'Therascript Update-Signatur — RESERVESCHLÜSSEL (privat)',
    `Schlüssel-ID: ${backup.keyId}`,
    '',
    'In den Passwort-Manager übernehmen und diese Datei löschen.',
    'Verwenden nur nach Verlust des Hauptschlüssels:',
    '  THERASCRIPT_SIGNING_KEY_FILE=<datei> scripts/publish-manifest.sh --from-catalog',
    '',
    backup.privateKey,
    ''
  ].join('\n'),
  { mode: 0o600 }
)

const source = readFileSync(KEYS_FILE, 'utf8')
const entries = [primary, backup]
  .map((k) => `  {\n    keyId: '${k.keyId}',\n    publicKey: '${k.publicKey}'\n  }`)
  .join(',\n')
const updated = source.replace(
  'export const UPDATE_SIGNING_KEYS: readonly UpdateSigningKey[] = []',
  `export const UPDATE_SIGNING_KEYS: readonly UpdateSigningKey[] = [\n${entries}\n]`
)
if (updated === source) throw new Error('UPDATE_SIGNING_KEYS in update-keys.ts nicht gefunden')
writeFileSync(KEYS_FILE, updated)

console.log(`Hauptschlüssel ${primary.keyId}: im Schlüsselbund (Dienst therascript-update-signing)`)
console.log(`Reserveschlüssel ${backup.keyId}: ${backupFile}`)
console.log('  → in den Passwort-Manager übernehmen, dann die Datei löschen')
console.log('Öffentliche Schlüssel eingetragen in src/shared/update-keys.ts — committen.')
