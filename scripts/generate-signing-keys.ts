#!/usr/bin/env -S npx tsx
/**
 * Signaturschlüssel der Update-Beschreibung (Issue #163, AK 5).
 *
 *   npx tsx scripts/generate-signing-keys.ts                  erstes Schlüsselpaar
 *   npx tsx scripts/generate-signing-keys.ts --rotate         Nachfolger-Paar anhängen
 *   npx tsx scripts/generate-signing-keys.ts --activate-next  Nachfolger signiert ab jetzt
 *
 * Ein Paar besteht aus
 *   - Hauptschlüssel: privat im Schlüsselbund (scripts/lib/signing-keychain.ts)
 *   - Reserveschlüssel: privat in eine Datei auf dem Schreibtisch — sofort in
 *     den Passwort-Manager übernehmen und die Datei löschen. Er signiert nur,
 *     wenn ein Hauptschlüssel verloren ist.
 * Die öffentlichen Schlüssel schreibt das Skript nach src/shared/update-keys.ts.
 *
 * Wechsel (geplant oder nach Verlust) ohne Neuinstallation:
 *   1. --rotate: neues Paar wird angehängt, die alten Einträge bleiben; der
 *      neue Hauptschlüssel liegt als «next» im Schlüsselbund
 *   2. Release ausliefern, der beiden Generationen vertraut — signiert mit dem
 *      bisherigen Hauptschlüssel, nach einem Verlust mit dem Reserveschlüssel
 *      (THERASCRIPT_SIGNING_KEY_FILE)
 *   3. Sobald dieser Release verbreitet ist: --activate-next
 *   4. In einem späteren Release die alten Einträge aus update-keys.ts löschen
 *
 * Kein privater Schlüssel erscheint auf der Konsole. Alle Voraussetzungen
 * werden geprüft, bevor etwas geschrieben wird.
 */
import { generateKeyPairSync } from 'crypto'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { publicKeyFromPrivate } from '../src/main/services/ManifestSignature'
import { UPDATE_SIGNING_KEYS, type UpdateSigningKey } from '../src/shared/update-keys'
import {
  KEYCHAIN_CURRENT,
  KEYCHAIN_NEXT,
  deleteKeychainKey,
  readKeychainKey,
  storeKeychainKey
} from './lib/signing-keychain'

const KEYS_FILE = join(__dirname, '..', 'src', 'shared', 'update-keys.ts')
const KEYS_PATTERN =
  /export const UPDATE_SIGNING_KEYS: readonly UpdateSigningKey\[\] = \[[\s\S]*?\n?\]/

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function newKey(): { privateKey: string; publicKey: string } {
  const { privateKey } = generateKeyPairSync('ed25519')
  const der = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
  return { privateKey: der, publicKey: publicKeyFromPrivate(der) }
}

function uniqueKeyId(base: string): string {
  const taken = new Set(UPDATE_SIGNING_KEYS.map((k) => k.keyId))
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
}

function renderKeys(keys: readonly UpdateSigningKey[]): string {
  const entries = keys
    .map((k) => `  {\n    keyId: '${k.keyId}',\n    publicKey: '${k.publicKey}'\n  }`)
    .join(',\n')
  return `export const UPDATE_SIGNING_KEYS: readonly UpdateSigningKey[] = [\n${entries}\n]`
}

const mode = process.argv[2] ?? 'init'

if (mode === '--activate-next') {
  const next = readKeychainKey(KEYCHAIN_NEXT)
  if (!next) fail(`Kein Nachfolger im Schlüsselbund (Dienst «${KEYCHAIN_NEXT}»).`)
  const trusted = UPDATE_SIGNING_KEYS.find((k) => k.publicKey === publicKeyFromPrivate(next))
  if (!trusted)
    fail('Der Nachfolger steht nicht in UPDATE_SIGNING_KEYS — erst --rotate ausliefern.')
  storeKeychainKey(KEYCHAIN_CURRENT, 'Therascript Update-Signatur (Hauptschlüssel)', next)
  deleteKeychainKey(KEYCHAIN_NEXT)
  console.log(`Ab jetzt signiert ${trusted.keyId}.`)
  process.exit(0)
}

if (mode === 'init' && UPDATE_SIGNING_KEYS.length > 0) {
  fail('update-keys.ts enthält schon Schlüssel — für einen Wechsel: --rotate')
}
if (mode === '--rotate' && UPDATE_SIGNING_KEYS.length === 0) {
  fail('Noch keine Schlüssel — zuerst ohne Option ausführen.')
}
if (mode !== 'init' && mode !== '--rotate') {
  fail('Usage: generate-signing-keys.ts [--rotate | --activate-next]')
}
if (mode === '--rotate' && readKeychainKey(KEYCHAIN_NEXT)) {
  fail(
    `Es liegt schon ein Nachfolger im Schlüsselbund («${KEYCHAIN_NEXT}») — erst --activate-next.`
  )
}

// ── Alles vorbereiten und prüfen, bevor geschrieben wird ─────────────────
const generation = new Date().toISOString().slice(0, 7)
const primary = { keyId: uniqueKeyId(`primary-${generation}`), ...newKey() }
const backup = { keyId: uniqueKeyId(`backup-${generation}`), ...newKey() }
const backupFile = join(homedir(), 'Desktop', `therascript-update-signing-${backup.keyId}.txt`)
if (existsSync(backupFile)) fail(`${backupFile} existiert schon — abgebrochen, nichts geschrieben.`)
const source = readFileSync(KEYS_FILE, 'utf8')
if (!KEYS_PATTERN.test(source)) fail('UPDATE_SIGNING_KEYS in update-keys.ts nicht gefunden.')
const updated = source.replace(
  KEYS_PATTERN,
  renderKeys(
    [...UPDATE_SIGNING_KEYS, primary, backup].map(({ keyId, publicKey }) => ({ keyId, publicKey }))
  )
)

// ── Schreiben: Reserve-Datei, Schlüsselbund, zuletzt update-keys.ts ──────
// Bricht ein Schritt ab, lässt sich der Lauf wiederholen: Der Schlüsselbund
// wird ersetzt (-U), und erst der letzte Schritt macht den Schlüssel gültig.
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
const service = mode === 'init' ? KEYCHAIN_CURRENT : KEYCHAIN_NEXT
storeKeychainKey(service, `Therascript Update-Signatur (${primary.keyId})`, primary.privateKey)
writeFileSync(KEYS_FILE, updated)

console.log(`Hauptschlüssel ${primary.keyId}: im Schlüsselbund (Dienst ${service})`)
console.log(`Reserveschlüssel ${backup.keyId}: ${backupFile}`)
console.log('  → in den Passwort-Manager übernehmen, dann die Datei löschen')
console.log('Öffentliche Schlüssel eingetragen in src/shared/update-keys.ts — committen.')
if (mode === '--rotate') {
  console.log('Signiert wird weiter mit dem bisherigen Schlüssel. Nach Verbreitung des')
  console.log('nächsten Releases: npx tsx scripts/generate-signing-keys.ts --activate-next')
}
