import type { InstalledModelVersion } from '../../shared/types/ModelUpdate'
import { getSettings } from './SettingsService'
import { getChannel } from './Channel'

/**
 * Issue #84 / Story D — channel-aware adapter over electron-store's
 * `installedModelVersions`. The on-disk record stores keys as
 * `${channel}:${modelId}`; this module is the only place that knows
 * about that prefix so call sites work in plain modelId terms and a
 * channel switch can never bleed install records across channels
 * (NFR-3 — no false-positive update banners after a channel switch).
 */

function tagKey(modelId: string): string {
  return `${getChannel()}:${modelId}`
}

function readRaw(): Record<string, InstalledModelVersion> {
  // electron-store can return undefined or a non-object if the file was
  // tampered with; coerce to an empty record rather than crashing.
  const raw = getSettings().get('installedModelVersions')
  if (!raw || typeof raw !== 'object') return {}
  return raw as Record<string, InstalledModelVersion>
}

function writeRaw(next: Record<string, InstalledModelVersion>): void {
  getSettings().set('installedModelVersions', next)
}

/**
 * Returns the installed-versions view for the active channel, keyed by
 * plain model id (no prefix). Other channels' entries are filtered out.
 */
export function getInstalledVersions(): Record<string, InstalledModelVersion> {
  const raw = readRaw()
  const prefix = `${getChannel()}:`
  const result: Record<string, InstalledModelVersion> = {}
  for (const [key, val] of Object.entries(raw)) {
    if (key.startsWith(prefix)) {
      result[key.slice(prefix.length)] = val
    }
  }
  return result
}

/** Returns the installed-version record for one model in the active channel. */
export function getInstalledVersion(modelId: string): InstalledModelVersion | null {
  return readRaw()[tagKey(modelId)] ?? null
}

/** Upserts an installed-version record for the active channel. */
export function setInstalledVersion(modelId: string, val: InstalledModelVersion): void {
  const next = { ...readRaw() }
  next[tagKey(modelId)] = val
  writeRaw(next)
}

/** Removes the installed-version record for the active channel. */
export function deleteInstalledVersion(modelId: string): void {
  const next = { ...readRaw() }
  delete next[tagKey(modelId)]
  writeRaw(next)
}

/**
 * Bulk replacement of the active channel's view. Used by the legacy-rename
 * migration path inside UpdateCheckService.migrateInstalledVersions —
 * other channels' entries stay intact.
 */
export function replaceInstalledVersionsForChannel(
  next: Record<string, InstalledModelVersion>
): void {
  const channel = getChannel()
  const prefix = `${channel}:`
  const all = readRaw()
  // Strip every entry for the active channel, then re-add what the caller passes.
  const merged: Record<string, InstalledModelVersion> = {}
  for (const [key, val] of Object.entries(all)) {
    if (!key.startsWith(prefix)) merged[key] = val
  }
  for (const [id, val] of Object.entries(next)) {
    merged[`${channel}:${id}`] = val
  }
  writeRaw(merged)
}
