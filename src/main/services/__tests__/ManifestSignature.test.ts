import { describe, it, expect } from 'vitest'
import { generateKeyPairSync } from 'crypto'
import { publicKeyFromPrivate, signManifest, verifyManifestSignature } from '../ManifestSignature'
import { manifestSignaturePath, type UpdateSigningKey } from '../../../shared/update-keys'

function keyPair(keyId: string): { privateKey: string; trusted: UpdateSigningKey } {
  const { privateKey } = generateKeyPairSync('ed25519')
  const privateKeyBase64 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
  return {
    privateKey: privateKeyBase64,
    trusted: { keyId, publicKey: publicKeyFromPrivate(privateKeyBase64) }
  }
}

const primary = keyPair('primary-test')
const backup = keyPair('backup-test')
const trusted = [primary.trusted, backup.trusted]
const manifest = Buffer.from('{"latestAppVersion":"1.2.3","models":[]}\n')

describe('signManifest / verifyManifestSignature', () => {
  it('bestätigt ein mit dem Hauptschlüssel signiertes Manifest', () => {
    const signature = signManifest(manifest, primary.privateKey, trusted)
    expect(signature.keyId).toBe('primary-test')
    expect(verifyManifestSignature(manifest, signature, trusted)).toBe(true)
  })

  it('bestätigt auch eine Signatur mit dem Reserveschlüssel (Wechsel nach Verlust)', () => {
    const signature = signManifest(manifest, backup.privateKey, trusted)
    expect(signature.keyId).toBe('backup-test')
    expect(verifyManifestSignature(manifest, signature, trusted)).toBe(true)
  })

  it('lehnt ein verändertes Manifest ab', () => {
    const signature = signManifest(manifest, primary.privateKey, trusted)
    const tampered = Buffer.from(manifest.toString().replace('1.2.3', '9.9.9'))
    expect(verifyManifestSignature(tampered, signature, trusted)).toBe(false)
  })

  it('lehnt eine Signatur eines nicht vertrauenswürdigen Schlüssels ab', () => {
    const attacker = keyPair('primary-test')
    const forged = signManifest(manifest, attacker.privateKey, [attacker.trusted])
    expect(verifyManifestSignature(manifest, forged, trusted)).toBe(false)
  })

  it('lehnt unbekannte Schlüssel-IDs und kaputte Signaturen ab', () => {
    const signature = signManifest(manifest, primary.privateKey, trusted)
    expect(verifyManifestSignature(manifest, { ...signature, keyId: 'other' }, trusted)).toBe(false)
    expect(verifyManifestSignature(manifest, { ...signature, signature: 'AAAA' }, trusted)).toBe(
      false
    )
    expect(verifyManifestSignature(manifest, { keyId: 'primary-test' }, trusted)).toBe(false)
    expect(verifyManifestSignature(manifest, null, trusted)).toBe(false)
  })

  it('signiert nicht mit einem Schlüssel, den die App nicht kennt', () => {
    const stranger = keyPair('stranger')
    expect(() => signManifest(manifest, stranger.privateKey, trusted)).toThrow(
      /UPDATE_SIGNING_KEYS/
    )
  })
})

describe('manifestSignaturePath', () => {
  it('leitet den Pfad aus dem Manifest-Hash ab', () => {
    expect(manifestSignaturePath('ab'.repeat(32))).toBe(`signatures/${'ab'.repeat(32)}.json`)
  })
})
