import { useSyncExternalStore } from 'react'
import { ambiguousDossierNames } from '../utils/dossierFormat'

/**
 * Welche Dossier-Namen mehrfach vorkommen (Sichtprüfung: gleichnamige
 * Dossiers unterscheidbar machen, wo sonst nur der Name steht — «Zuletzt
 * geöffnet», Plaketten, Toasts). Eine Quelle für die ganze App: geladen beim
 * ersten Abonnenten, nachgeladen bei jedem `dossiers:changed`, freigegeben,
 * wenn niemand mehr zuhört. Hält nur Vergleichsschlüssel, keine Namen.
 */

const EMPTY: ReadonlySet<string> = new Set()

let snapshot: ReadonlySet<string> = EMPTY
const listeners = new Set<() => void>()
let offChanged: (() => void) | null = null
let generation = 0

function emit(): void {
  for (const listener of listeners) listener()
}

function load(): void {
  const api = typeof window === 'undefined' ? undefined : window.api?.dossiers
  if (!api?.list) return
  const mine = ++generation
  Promise.resolve()
    .then(() => api.list())
    .then((list) => {
      if (mine !== generation || !Array.isArray(list)) return
      const next = ambiguousDossierNames(list)
      const same = next.size === snapshot.size && [...next].every((key) => snapshot.has(key))
      if (same) return
      snapshot = next
      emit()
    })
    .catch(() => {
      // Ohne Liste kein Zusatz — die Namen bleiben lesbar
    })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    // Frisch laden statt einen alten Stand zu zeigen (die Seitenleiste hört in
    // der App ohnehin dauernd zu; in Tests trennt das die Fälle)
    snapshot = EMPTY
    load()
    const onChanged = window.api?.dossiers?.onChanged
    offChanged = onChanged ? onChanged(() => load()) : null
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      offChanged?.()
      offChanged = null
      generation++
    }
  }
}

/** Aktueller Stand ohne Abonnement (z. B. für einen Toast aus einem Callback). */
export function getAmbiguousDossierNames(): ReadonlySet<string> {
  return snapshot
}

/** Schlüssel der mehrfach vergebenen Namen; neu gerendert, wenn sich das ändert. */
export function useAmbiguousDossierNames(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, getAmbiguousDossierNames, getAmbiguousDossierNames)
}

/** Nur für Tests. */
export function _resetDossierNamesForTests(): void {
  offChanged?.()
  offChanged = null
  listeners.clear()
  snapshot = EMPTY
  generation++
}
