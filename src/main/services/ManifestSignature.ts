import { createPrivateKey, createPublicKey, sign, verify } from 'crypto'
import { z } from 'zod'
import type { UpdateSigningKey } from '../../shared/update-keys'

/**
 * Ed25519-Signatur der Update-Beschreibung (ADR-009, Issue #163). Signiert
 * werden die exakten Bytes von manifest.json — kein kanonisches JSON, die App
 * prüft vor dem Parsen.
 */
export const ManifestSignatureSchema = z.object({
  keyId: z.string().min(1),
  algorithm: z.literal('ed25519'),
  signature: z.string().min(1)
})

export type ManifestSignature = z.infer<typeof ManifestSignatureSchema>

/** Öffentlicher Schlüssel (SPKI-DER, Base64) zu einem privaten (PKCS8-DER, Base64). */
export function publicKeyFromPrivate(privateKeyBase64: string): string {
  const privateKey = createPrivateKey({
    key: Buffer.from(privateKeyBase64, 'base64'),
    format: 'der',
    type: 'pkcs8'
  })
  return createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64')
}

/**
 * Signiert `manifest` mit dem privaten Schlüssel. Der Schlüssel muss zu einem
 * der vertrauenswürdigen Schlüssel gehören — sonst könnte die App die
 * Signatur nicht prüfen, und der Release ginge mit einer wertlosen Signatur
 * hinaus.
 */
export function signManifest(
  manifest: Buffer,
  privateKeyBase64: string,
  trustedKeys: readonly UpdateSigningKey[]
): ManifestSignature {
  const publicKey = publicKeyFromPrivate(privateKeyBase64)
  const key = trustedKeys.find((k) => k.publicKey === publicKey)
  if (!key) {
    throw new Error('Der Signaturschlüssel gehört zu keinem Schlüssel in UPDATE_SIGNING_KEYS')
  }
  const privateKey = createPrivateKey({
    key: Buffer.from(privateKeyBase64, 'base64'),
    format: 'der',
    type: 'pkcs8'
  })
  return {
    keyId: key.keyId,
    algorithm: 'ed25519',
    signature: sign(null, manifest, privateKey).toString('base64')
  }
}

/** true, wenn `signature` die Bytes `manifest` mit einem vertrauenswürdigen Schlüssel bestätigt. */
export function verifyManifestSignature(
  manifest: Buffer,
  signature: unknown,
  trustedKeys: readonly UpdateSigningKey[]
): boolean {
  const parsed = ManifestSignatureSchema.safeParse(signature)
  if (!parsed.success) return false
  const key = trustedKeys.find((k) => k.keyId === parsed.data.keyId)
  if (!key) return false
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(key.publicKey, 'base64'),
      format: 'der',
      type: 'spki'
    })
    return verify(null, manifest, publicKey, Buffer.from(parsed.data.signature, 'base64'))
  } catch {
    return false
  }
}
