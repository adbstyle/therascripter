import { createHash } from 'crypto'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'fs'
import { join } from 'path'
import { get as httpsGet } from 'https'
import { getSettings } from './SettingsService'
import { getModelDefinitions, getModelsDir, isModelInstalled } from './ModelDownloadService'
import { getInstalledVersions, setInstalledVersion } from './InstalledVersionsStore'
import { verifyFileSha256 } from './DownloadService'
import { parseManifest, type Manifest } from '../../shared/validation/model-update-schemas'
import { UPDATE_SIGNING_KEYS, manifestSignaturePath } from '../../shared/update-keys'
import { verifyManifestSignature } from './ManifestSignature'
import { getAppUpdateService } from './app-update-deps'

/**
 * Prüft auf Updates (Issues #163, #167): lädt die Update-Beschreibung samt
 * Signatur und übergibt sie dem AppUpdateService, der daraus das gemeinsame
 * Update aus App und Modellen berechnet, lädt und installiert.
 */

const MANIFEST_URL = 'https://pub-f6971d643e3a464ba6977c0816c43e50.r2.dev/manifest.json'

// ─── Manifest fetch ───────────────────────────────────────────────────────────

/** Lädt eine kleine Datei als Bytes (Manifest, Signatur — beide < 100 KB). */
function fetchSmallFile(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      reject(err)
    }
    const request = httpsGet(url, { timeout: 15000 }, (response) => {
      if (response.statusCode !== 200) {
        response.destroy()
        fail(new Error(`HTTP ${response.statusCode} für ${url}`))
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 100_000) {
          response.destroy()
          fail(new Error(`${url}: zu gross`))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => {
        if (settled) return
        settled = true
        resolve(Buffer.concat(chunks))
      })
      response.on('error', fail)
    })
    request.on('error', fail)
    request.on('timeout', () => {
      request.destroy()
      fail(new Error(`${url}: Timeout`))
    })
  })
}

/**
 * Lädt die Update-Beschreibung und prüft ihre Signatur (Issue #163/#164).
 * Die Signatur liegt unter signatures/<sha256 der Manifest-Bytes>.json — so
 * passt sie immer zu genau den Bytes, die diese App erhalten hat. Ohne gültige
 * Signatur eines vertrauenswürdigen Schlüssels gibt es weder App- noch
 * Modell-Updates: ein kompromittierter Download-Server kann nichts unterschieben.
 */
export async function fetchVerifiedManifest(
  fetchFile: (url: string) => Promise<Buffer> = fetchSmallFile
): Promise<Manifest> {
  const bytes = await fetchFile(MANIFEST_URL)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const signatureUrl = MANIFEST_URL.replace(/manifest\.json$/, manifestSignaturePath(sha256))
  let signature: unknown
  try {
    signature = JSON.parse((await fetchFile(signatureUrl)).toString('utf8'))
  } catch (err) {
    throw new Error(
      `Signatur der Update-Beschreibung fehlt: ${err instanceof Error ? err.message : err}`
    )
  }
  if (!verifyManifestSignature(bytes, signature, UPDATE_SIGNING_KEYS)) {
    throw new Error('Signatur der Update-Beschreibung ungültig — Updates werden ignoriert')
  }
  return parseManifest(JSON.parse(bytes.toString('utf8')), (m) =>
    console.warn(`UpdateCheckService: ${m}`)
  )
}

// ─── checkForUpdates ─────────────────────────────────────────────────────────

let checkRunning: Promise<void> | null = null

/**
 * Prüft auf Updates. Gleichzeitige Aufrufe (Start, Intervall, «Nach Updates
 * suchen») teilen sich einen Lauf. Fehler bleiben still — der Update-Zustand
 * zeigt «Prüfung nicht gelungen».
 */
export function checkForUpdates(): Promise<void> {
  checkRunning ??= runCheck().finally(() => {
    checkRunning = null
  })
  return checkRunning
}

async function runCheck(): Promise<void> {
  try {
    const manifest = await fetchVerifiedManifest()
    await healLegacyInstalledHashes(manifest)
    getAppUpdateService()?.handleManifest(manifest)
  } catch (error) {
    console.log(`UpdateCheckService: Update-Check fehlgeschlagen (ignoriert): ${error}`)
    // Sonst stünde in Einstellungen → Updates «aktuell», obwohl nichts geprüft wurde
    getAppUpdateService()?.handleCheckFailed()
  }
}

/**
 * Lazy heal of the legacy '' sentinel from migrateInstalledVersions: for
 * non-archive models we can hash the file on disk and compare against the
 * manifest. If they match, the install is bit-identical to the current
 * manifest version — backfill the real hash so it is not offered as an
 * update (Issue #84 / Story B). Archive models can't be hashed post-extract
 * (the .tar.gz is gone); they are offered once, and installing writes the
 * real hash.
 */
async function healLegacyInstalledHashes(manifest: Manifest): Promise<void> {
  const installed = getInstalledVersions()
  const definitions = new Map(getModelDefinitions().map((d) => [d.id, d]))
  for (const entry of manifest.models) {
    const record = installed[entry.id]
    const definition = definitions.get(entry.id)
    if (record?.sha256 !== '' || !definition || definition.archive) continue
    if (!isModelInstalled(entry.id)) continue
    const filePath = join(getModelsDir(), definition.relativePath)
    if (existsSync(filePath) && (await verifyFileSha256(filePath, entry.sha256))) {
      setInstalledVersion(entry.id, { ...record, sha256: entry.sha256 })
    }
  }
}

// ─── cleanupIncompleteUpdates ────────────────────────────────────────────────

/**
 * Altlast des Modell-Update-Ablaufs vor #167 (models/.staging, .backup):
 * räumt nach einem Update aus einer älteren Version auf und stellt ein
 * Modell aus einem abgebrochenen Austausch wieder her. Das gemeinsame
 * Update stellt unter models/.update/ bereit (model-staging.ts).
 */
export function cleanupIncompleteUpdates(): void {
  const modelsDir = getModelsDir()
  const stagingDir = join(modelsDir, '.staging')
  const backupDir = join(modelsDir, '.backup')

  // Delete incomplete staging dir
  if (existsSync(stagingDir)) {
    try {
      rmSync(stagingDir, { recursive: true })
      console.log('UpdateCheckService: .staging/ bereinigt')
    } catch (err) {
      console.error('UpdateCheckService: .staging/ konnte nicht bereinigt werden:', err)
    }
  }

  // Recover from interrupted swaps: if backup exists but model is missing → restore
  if (!existsSync(backupDir)) return

  const definitions = getModelDefinitions()

  try {
    const backupEntries = readdirSync(backupDir)
    for (const entry of backupEntries) {
      const backupPath = join(backupDir, entry)
      const definition = definitions.find((d) => d.id === entry)
      if (!definition) continue

      const finalPath = join(modelsDir, definition.relativePath)
      const checkTarget = join(modelsDir, definition.checkPath)

      if (!existsSync(checkTarget)) {
        // Model is missing — restore from backup
        try {
          // Ensure parent dir for flat files
          if (definition.relativePath.includes('/')) {
            const parentDir = join(
              modelsDir,
              definition.relativePath.split('/').slice(0, -1).join('/')
            )
            mkdirSync(parentDir, { recursive: true })
          }
          renameSync(backupPath, finalPath)
          console.log(`UpdateCheckService: Backup wiederhergestellt: ${entry}`)
        } catch (err) {
          console.error(
            `UpdateCheckService: Backup-Wiederherstellung fehlgeschlagen: ${entry}:`,
            err
          )
        }
      } else {
        // Model exists — swap completed, cleanup missed backup
        try {
          rmSync(backupPath, { recursive: true })
        } catch {
          /* non-fatal */
        }
      }
    }

    // Remove backupDir if now empty
    if (readdirSync(backupDir).length === 0) {
      rmSync(backupDir, { recursive: true })
    }
  } catch (err) {
    console.error('UpdateCheckService: .backup/ cleanup fehlgeschlagen:', err)
  }
}

// ─── migrateInstalledVersions ─────────────────────────────────────────────────

/**
 * Backfills an empty `installedModelVersions` view for the active channel
 * with `'pre-update'` sentinel rows whenever a model file exists on disk.
 *
 * Story D — the per-channel guard means a freshly switched channel sees
 * its own (initially empty) view, even when other channels already have
 * entries; the disk files are reused in-place by the new channel.
 *
 * Boot-phase invariant: this MUST run after `initSettings` has applied the
 * Story-D channel-tag migration. If we hit untagged keys in the raw record,
 * the channel-aware adapter would silently filter them out (treating the
 * channel view as empty) and write fresh `prod:`-prefixed sentinel rows
 * alongside the legacy untagged ones — producing duplicate entries. Bailing
 * loudly here surfaces the boot-order regression at the source rather than
 * a few releases later as a mysterious manifest mismatch.
 */
export function migrateInstalledVersions(): void {
  const raw = getSettings().get('installedModelVersions') ?? {}
  const untaggedKey = Object.keys(raw).find((k) => !k.includes(':'))
  if (untaggedKey !== undefined) {
    throw new Error(
      `migrateInstalledVersions called before initSettings: untagged key "${untaggedKey}" present. ` +
        'The Story-D channel-tag migration in initSettings must run first.'
    )
  }

  const installedVersions = getInstalledVersions()
  if (Object.keys(installedVersions).length > 0) return

  const modelsDir = getModelsDir()
  const definitions = getModelDefinitions()
  const now = new Date().toISOString()
  let migrated = 0

  for (const def of definitions) {
    const checkTarget = join(modelsDir, def.checkPath)
    if (existsSync(checkTarget)) {
      setInstalledVersion(def.id, {
        version: 'pre-update',
        sha256: '', // Unknown — forces update on first manifest check
        installedAt: now
      })
      migrated++
    }
  }

  if (migrated > 0) {
    console.log(`UpdateCheckService: ${migrated} bestehende Modelle migriert`)
  }
}
