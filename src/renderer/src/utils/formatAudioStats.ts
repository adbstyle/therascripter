/**
 * Format helpers for the Audio section of the Provenance panel (Issue #99).
 *
 * Durations render as `xh ym zs` (hours/minutes only when non-zero on the
 * leading side). Avoids the `mm:ss` clock format because the Provenance panel
 * sits next to the "Verarbeitet am" timestamp — `8:53` looks like a wall-clock
 * time at a glance.
 */

export function formatHms(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60

  const parts: string[] = []
  if (h > 0) parts.push(`${h}h`)
  if (h > 0 || m > 0) parts.push(`${m}m`)
  parts.push(`${s}s`)
  return parts.join(' ')
}

/**
 * Combines silence duration and its share of the original. Returns
 * `xh ym zs · YY.Y %`. When `originalSeconds` is 0 (degenerate case),
 * the share is omitted to avoid division-by-zero noise.
 */
export function formatSilenceWithShare(silenceSeconds: number, originalSeconds: number): string {
  const base = formatHms(silenceSeconds)
  if (originalSeconds <= 0) return base
  const pct = (silenceSeconds / originalSeconds) * 100
  return `${base} · ${formatPercentDeCh(pct)}`
}

export function formatPercentDeCh(value: number): string {
  const clamped = Number.isFinite(value) ? value : 0
  const rounded = Math.round(clamped * 10) / 10
  return `${rounded.toFixed(1)} %`
}
