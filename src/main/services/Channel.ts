/**
 * Issue #84 / Story D — Pre-Release-Verifikations-Channel.
 *
 * The active channel is fixed at app start by the env var
 * `THERASCRIPT_CHANNEL` (set at build/dev time, not user-switchable).
 * It tags every entry written into `installedModelVersions` so that
 * switching the build between `prod` and a non-prod channel cannot
 * leak stale install records into the other channel — which would
 * otherwise produce false-positive "Update verfügbar" banners (NFR-3).
 *
 * The `prod` default keeps shipped builds and the existing electron-
 * store data fully backward-compatible: untagged legacy keys are
 * migrated to the `prod:` prefix on first launch (see SettingsService).
 */

export const CHANNELS = ['prod', 'staging', 'local'] as const
export type Channel = (typeof CHANNELS)[number]

const DEFAULT_CHANNEL: Channel = 'prod'

function isChannel(value: string | undefined): value is Channel {
  return (CHANNELS as readonly string[]).includes(value ?? '')
}

let cached: Channel | null = null

/** Returns the active channel, validated against {prod, staging, local}. */
export function getChannel(): Channel {
  if (cached) return cached
  const raw = process.env.THERASCRIPT_CHANNEL
  if (raw && !isChannel(raw)) {
    console.warn(
      `[channel] THERASCRIPT_CHANNEL="${raw}" is not one of ${CHANNELS.join('|')} — falling back to "${DEFAULT_CHANNEL}".`
    )
  }
  cached = isChannel(raw) ? raw : DEFAULT_CHANNEL
  if (cached !== 'prod') {
    console.log(`[channel] Active channel: ${cached}`)
  }
  return cached
}

/** Test-only — clears the cache so a different env value can be picked up. */
export function _resetChannelCacheForTests(): void {
  cached = null
}
