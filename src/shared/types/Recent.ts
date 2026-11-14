import type { Session } from './Session'
import type { DossierRef } from './Dossier'

/**
 * Eintrag in «Zuletzt geöffnet» (#213): ein Patientendossier oder eine
 * Sitzung bzw. ein PDF-Dokument (Listen-Projektion mit Klartext-Titel, damit
 * der Renderer den Titel in der gewählten Ansicht zeigt, AK 4).
 * `recording` markiert die laufende Aufnahme (steht immer zuerst, AK 2).
 */
export type RecentEntry =
  | { kind: 'dossier'; dossier: DossierRef }
  | { kind: 'session'; session: Session; recording: boolean }

/** Ziel von `recent:touch`. */
export type RecentTouchTarget = { kind: 'dossier'; id: string } | { kind: 'session'; id: string }
