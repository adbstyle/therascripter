import { useRef, useCallback, useEffect, useState } from 'react'

interface UseAutoSaveResult {
  saving: boolean
  lastSavedAt: number | null
}

export function useAutoSave(
  onSave: (() => Promise<void>) | null,
  deps: unknown[],
  delay = 2000
): UseAutoSaveResult {
  const [saving, setSaving] = useState(false)
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onSaveRef = useRef(onSave)
  const isFirstRender = useRef(true)

  onSaveRef.current = onSave

  const scheduleSave = useCallback(() => {
    if (!onSaveRef.current) return

    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
    }

    timeoutRef.current = setTimeout(async () => {
      if (!onSaveRef.current) return
      setSaving(true)
      try {
        await onSaveRef.current()
        setLastSavedAt(Date.now())
      } catch (err) {
        console.error('Auto-save failed:', err)
      } finally {
        setSaving(false)
      }
    }, delay)
  }, [delay])

  // Schedule save when deps change, but skip first render
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false
      return
    }
    scheduleSave()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  // Cleanup on unmount — flush pending save
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
        // Fire save synchronously-ish on unmount (best-effort)
        onSaveRef.current?.().catch(console.error)
      }
    }
  }, [])

  return { saving, lastSavedAt }
}
