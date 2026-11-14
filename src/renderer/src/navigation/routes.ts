/**
 * Seiten der App (Epic #192). Die Suche (#209/#211) ergänzt die Suche im
 * Patientendossier und Fundstellen als `focus` einer Sitzung.
 */

/** Unterseiten der Einstellungen; Teil der Route, damit ‹ auch dort zurückführt. */
export type SubPage = 'sperrliste' | 'darstellung' | 'modelle' | 'updates' | 'ueber'

import type { SearchFocus } from '../../../shared/types/Search'

/**
 * Stelle in einer Sitzung, zu der gesprungen wird (#209 AK 11): eine
 * Fundstelle der Suche (Titel, Zusammenfassung oder Absätze mit Markierungen)
 * oder ein Absatz.
 */
export type SessionFocus = SearchFocus | { kind: 'paragraph'; index: number }

export type Route =
  | { kind: 'sessions' }
  | { kind: 'dossiers' }
  | { kind: 'dossier'; dossierId: string }
  /** Suche nur in diesem Patientendossier (#211). */
  | { kind: 'dossierSearch'; dossierId: string }
  | { kind: 'session'; sessionId: string; focus?: SessionFocus }
  | { kind: 'settings'; subpage: SubPage | null }

export type RouteKind = Route['kind']

/** Startseite der App und Ziel, wenn der Verlauf nichts mehr hergibt. */
export const HOME_ROUTE: Route = { kind: 'sessions' }

/**
 * Eindeutiger Schlüssel der Seite. `focus` gehört bewusst nicht dazu: ein
 * Sprung an eine andere Stelle derselben Sitzung ist keine neue Seite.
 */
export function routeKey(route: Route): string {
  switch (route.kind) {
    case 'sessions':
    case 'dossiers':
      return route.kind
    case 'dossier':
      return `dossier:${route.dossierId}`
    case 'dossierSearch':
      return `dossierSearch:${route.dossierId}`
    case 'session':
      return `session:${route.sessionId}`
    case 'settings':
      return `settings:${route.subpage ?? ''}`
  }
}

export function sameRoute(a: Route, b: Route): boolean {
  return routeKey(a) === routeKey(b)
}
