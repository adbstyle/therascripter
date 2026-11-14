import { HOME_ROUTE, sameRoute, type Route } from './routes'

/**
 * Verlauf der besuchten Seiten (Epic #192, #213 AK 5) als reine Funktion.
 * Lebt nur im Speicher — nach einem Neustart beginnt er leer (#213 OOS 1).
 */

/** Höchstzahl Einträge im Verlauf (zurück + aktuell + vorwärts). */
export const MAX_HISTORY = 50

export interface Entry {
  /** Eindeutig pro Besuch; Schlüssel für Scroll-Position und Seiten-Remount. */
  id: number
  route: Route
  /** Karte, die beim Zurückkehren sichtbar und hervorgehoben sein soll. */
  anchorId?: string
  /** Beim Zurückkehren wieder zu öffnendes Overlay (#209 AK 12, noch ungenutzt). */
  reopenOverlay?: 'search'
}

export interface NavState {
  back: Entry[]
  current: Entry
  forward: Entry[]
  nextId: number
}

export interface NavigateOptions {
  /** Aktuellen Eintrag ersetzen statt einen neuen anzulegen. */
  replace?: boolean
  /** Wird auf den AKTUELLEN Eintrag geschrieben (Herkunft), bevor gewechselt wird. */
  anchorId?: string
  reopenOverlay?: 'search'
}

export type RouteValidator = (route: Route) => boolean

export type NavAction =
  | { type: 'navigate'; route: Route; options?: NavigateOptions }
  | {
      type: 'back'
      /** Nur ausführen, wenn dieser Eintrag noch der aktuelle ist. */
      fromEntryId?: number
      /** Ziel, wenn kein gültiger Eintrag zurück mehr existiert. */
      fallback?: Route
      isValid?: RouteValidator
    }
  | { type: 'forward'; isValid?: RouteValidator }
  | { type: 'purge'; predicate: (route: Route) => boolean }
  /** Anker eines Eintrags verwerfen, sobald er eingelöst ist (einmal pro Rückkehr). */
  | { type: 'consumeAnchor'; entryId: number }

export function initialNavState(route: Route = HOME_ROUTE): NavState {
  return { back: [], current: { id: 1, route }, forward: [], nextId: 2 }
}

const always: RouteValidator = () => true

export function navReducer(state: NavState, action: NavAction): NavState {
  switch (action.type) {
    case 'navigate':
      return navigate(state, action.route, action.options ?? {})
    case 'back':
      if (action.fromEntryId !== undefined && action.fromEntryId !== state.current.id) {
        return state
      }
      return step(state, 'back', action.isValid ?? always, action.fallback)
    case 'forward':
      return step(state, 'forward', action.isValid ?? always)
    case 'purge':
      return purge(state, action.predicate)
    case 'consumeAnchor': {
      if (state.current.id !== action.entryId || state.current.anchorId === undefined) return state
      const { anchorId: _consumed, ...current } = state.current
      return { ...state, current }
    }
  }
}

function navigate(state: NavState, route: Route, options: NavigateOptions): NavState {
  const origin: Entry = {
    ...state.current,
    ...(options.anchorId !== undefined ? { anchorId: options.anchorId } : {}),
    ...(options.reopenOverlay !== undefined ? { reopenOverlay: options.reopenOverlay } : {})
  }

  if (sameRoute(state.current.route, route)) {
    // Dieselbe Seite: kein neuer Eintrag. Eine andere Stelle (focus) derselben
    // Sitzung übernimmt der aktuelle Eintrag.
    if (route === state.current.route) return state
    return { ...state, current: { ...origin, route } }
  }

  if (options.replace) {
    return {
      ...state,
      current: { id: state.nextId, route },
      nextId: state.nextId + 1
    }
  }

  const back = [...state.back, origin]
  // Begrenzung: die ältesten Einträge fallen weg (aktuell zählt mit)
  const overflow = back.length + 1 - MAX_HISTORY
  return {
    back: overflow > 0 ? back.slice(overflow) : back,
    current: { id: state.nextId, route },
    forward: [],
    nextId: state.nextId + 1
  }
}

function step(
  state: NavState,
  direction: 'back' | 'forward',
  isValid: RouteValidator,
  fallback?: Route
): NavState {
  const from = direction === 'back' ? [...state.back] : [...state.forward]
  // Vorwärts liegt der nächste Eintrag vorne, zurück hinten
  let target: Entry | undefined
  while (from.length > 0) {
    const candidate = direction === 'back' ? from.pop()! : from.shift()!
    if (isValid(candidate.route) && !sameRoute(candidate.route, state.current.route)) {
      target = candidate
      break
    }
  }

  if (!target) {
    if (direction === 'back' && fallback && !sameRoute(fallback, state.current.route)) {
      return {
        back: [],
        current: { id: state.nextId, route: fallback },
        forward: [state.current, ...state.forward],
        nextId: state.nextId + 1
      }
    }
    return state
  }

  if (direction === 'back') {
    return {
      back: from,
      current: target,
      forward: [state.current, ...state.forward],
      nextId: state.nextId
    }
  }
  return {
    back: [...state.back, state.current],
    current: target,
    forward: from,
    nextId: state.nextId
  }
}

/**
 * Entfernt Einträge zu gelöschten Objekten (#213 PC 3). Zeigt der aktuelle
 * Eintrag auf ein gelöschtes Objekt, wird er ersetzt: ein Dossier durch die
 * Übersicht, eine Sitzung durch den vorherigen Eintrag (sonst die Startseite).
 */
function purge(state: NavState, predicate: (route: Route) => boolean): NavState {
  const keep = (entries: Entry[]): Entry[] => dedupe(entries.filter((e) => !predicate(e.route)))
  let back = keep(state.back)
  const forward = keep(state.forward)

  if (!predicate(state.current.route)) {
    if (back.length === state.back.length && forward.length === state.forward.length) {
      return state
    }
    return {
      ...state,
      back: dropAdjacent(back, state.current),
      forward: dropLeading(forward, state.current)
    }
  }

  const deleted = state.current.route
  let current: Entry
  let nextId = state.nextId
  if (deleted.kind === 'dossier') {
    current = { id: nextId++, route: { kind: 'dossiers' } }
  } else if (back.length > 0) {
    current = back[back.length - 1]
    back = back.slice(0, -1)
  } else {
    current = { id: nextId++, route: HOME_ROUTE }
  }
  return {
    back: dropAdjacent(back, current),
    current,
    forward: dropLeading(forward, current),
    nextId
  }
}

/** Nach dem Entfernen können zwei gleiche Seiten nebeneinander stehen. */
function dedupe(entries: Entry[]): Entry[] {
  return entries.filter((e, i) => i === 0 || !sameRoute(entries[i - 1].route, e.route))
}

/** Vorwärts darf nicht mit der aktuellen Seite beginnen — › wäre aktiv, ohne etwas zu tun. */
function dropLeading(forward: Entry[], current: Entry): Entry[] {
  const first = forward[0]
  return first && sameRoute(first.route, current.route) ? forward.slice(1) : forward
}

function dropAdjacent(back: Entry[], current: Entry): Entry[] {
  const last = back[back.length - 1]
  return last && sameRoute(last.route, current.route) ? back.slice(0, -1) : back
}
