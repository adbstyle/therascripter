import { useEffect, useState } from 'react'

interface SaveStatusProps {
  saving: boolean
  lastSavedAt: number | null
}

const MINUTE_MS = 60_000

/**
 * Speicherstatus im Footer des Review-Editors. Hat einen eigenen Takt für die
 * relative Zeitangabe: der Editor selbst rendert dank memo nicht periodisch
 * neu, "Gespeichert vor 12s" bliebe sonst stehen. Getaktet wird nur, wenn sich
 * der Text ändern kann — in der ersten Minute sekündlich, danach zum nächsten
 * Minutenwechsel.
 */
export function SaveStatus({ saving, lastSavedAt }: SaveStatusProps): React.JSX.Element {
  const [, setTick] = useState(0)

  useEffect(() => {
    if (saving || lastSavedAt == null) return
    let timer: ReturnType<typeof setTimeout>
    const schedule = (): void => {
      const age = Date.now() - lastSavedAt
      const delay = age < MINUTE_MS ? 1000 : MINUTE_MS - (age % MINUTE_MS)
      timer = setTimeout(() => {
        setTick((t) => t + 1)
        schedule()
      }, delay)
    }
    schedule()
    return () => clearTimeout(timer)
  }, [saving, lastSavedAt])

  return (
    <span className="text-xs text-text-tertiary">
      {saving ? 'Speichern...' : lastSavedAt ? `Gespeichert ${formatTimeAgo(lastSavedAt)}` : ''}
    </span>
  )
}

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 5) return 'gerade eben'
  if (seconds < 60) return `vor ${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `vor ${minutes} Min`
}
