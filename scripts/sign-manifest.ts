#!/usr/bin/env -S npx tsx
/**
 * Signiert eine Update-Beschreibung (Issue #163):
 *
 *   npx tsx scripts/sign-manifest.ts <manifest.json>
 *
 * Schreibt <manifest.json>.sig und gibt auf stdout den Pfad aus, unter dem die
 * Signatur auf R2 liegen muss (signatures/<sha256 des Manifests>.json).
 * Schlüssel: Hauptschlüssel aus dem Schlüsselbund; nach dessen Verlust der
 * Reserveschlüssel über THERASCRIPT_SIGNING_KEY_FILE (Datei mit dem
 * Base64-Schlüssel, z. B. aus dem Passwort-Manager exportiert).
 *
 * Prüft die Signatur danach selbst gegen UPDATE_SIGNING_KEYS — eine
 * Signatur, die die App nicht prüfen kann, geht nie hinaus.
 */
import { createHash } from 'crypto'
import { readFileSync, writeFileSync } from 'fs'
import { signManifest, verifyManifestSignature } from '../src/main/services/ManifestSignature'
import { UPDATE_SIGNING_KEYS, manifestSignaturePath } from '../src/shared/update-keys'
import { readSigningKeyFromKeychain } from './lib/signing-keychain'

function signingKey(): string {
  const file = process.env.THERASCRIPT_SIGNING_KEY_FILE
  if (!file) return readSigningKeyFromKeychain()
  // Die Reserve-Datei enthält Erklärtext; der Schlüssel ist die Base64-Zeile.
  const line = readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /^[A-Za-z0-9+/]{40,}={0,2}$/.test(l))
  if (!line) throw new Error(`Kein Schlüssel in ${file}`)
  return line
}

const manifestPath = process.argv[2]
if (!manifestPath) {
  console.error('Usage: npx tsx scripts/sign-manifest.ts <manifest.json>')
  process.exit(1)
}
if (UPDATE_SIGNING_KEYS.length === 0) {
  console.error('UPDATE_SIGNING_KEYS ist leer — zuerst npx tsx scripts/generate-signing-keys.ts')
  process.exit(1)
}

const manifest = readFileSync(manifestPath)
const signature = signManifest(manifest, signingKey(), UPDATE_SIGNING_KEYS)
if (!verifyManifestSignature(manifest, signature, UPDATE_SIGNING_KEYS)) {
  console.error('Selbstprüfung der Signatur fehlgeschlagen — nichts geschrieben')
  process.exit(1)
}
writeFileSync(`${manifestPath}.sig`, JSON.stringify(signature, null, 2) + '\n')
const sha256 = createHash('sha256').update(manifest).digest('hex')
console.error(`Signiert mit ${signature.keyId}`)
process.stdout.write(manifestSignaturePath(sha256) + '\n')
