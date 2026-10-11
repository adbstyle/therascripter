import { useEffect, useState } from 'react'

const CHECK_INTERVAL_MS = 60_000

export function startOfDay(date: Date = new Date()): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/**
 * Beginn des aktuellen Tags (ms), wechselt kurz nach Mitternacht. Für
 * memoisierte Anzeigen relativer Daten ("Gestern"), die sonst erst beim
 * nächsten Datenrefresh neu rendern. Minütlich geprüft statt auf Mitternacht
 * getimt: übersteht Ruhezustand und Uhrzeitwechsel, gleicher Wert rendert nicht.
 */
export function useStartOfToday(): number {
  const [today, setToday] = useState(() => startOfDay())

  useEffect(() => {
    const id = setInterval(() => setToday(startOfDay()), CHECK_INTERVAL_MS)
    return () => clearInterval(id)
  }, [])

  return today
}
