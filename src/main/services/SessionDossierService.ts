import type Database from 'better-sqlite3'
import { SessionDossierRepository } from '../db/repositories/SessionDossierRepository'
import { SessionRepository } from '../db/repositories/SessionRepository'
import { walCheckpointTruncate } from '../db/maintenance'
import { notifyDossiersChanged, notifySessionsChanged } from './ChangeEvents'
import type {
  DossierAssignmentResult,
  DossierRef,
  SessionListItem,
  TimelineEntry
} from '../../shared/types/Dossier'

/**
 * Sitzungen und PDF-Dokumente Patientendossiers zuordnen und den Verlauf
 * eines Dossiers lesen (#205).
 *
 * Eigene Klasse statt Erweiterung von DossierService: Stammdaten und Löschen
 * bleiben dort, die Zuordnung hier. Zuordnen und Lösen prüfen den Zustand der
 * Sitzung bewusst nicht (AK 3: auch während Aufnahme, Verarbeitung und nach
 * einem Fehler) und fassen weder Text noch Pseudonymisierung, Titel oder
 * Zusammenfassung an (PC 2). Ergebnisse sind typisierte Unions — Electron
 * verstümmelt Fehlermeldungen bei `invoke`.
 */
export class SessionDossierService {
  private assignments: SessionDossierRepository
  private sessions: SessionRepository

  constructor(private db: Database.Database) {
    this.assignments = new SessionDossierRepository(db)
    this.sessions = new SessionRepository(db)
  }

  /**
   * Sitzungsliste mit Dossier-Plaketten (#205 AK 5): die Listen-Projektion
   * plus EINE zweite Abfrage für alle Zuordnungen, zusammengeführt in JS.
   */
  listSessions(): SessionListItem[] {
    const sessions = this.sessions.findAll()
    const dossiers = this.assignments.listForSessions(sessions.map((s) => s.id))
    return sessions.map((session) => ({ ...session, dossiers: dossiers.get(session.id) ?? [] }))
  }

  listForSession(sessionId: string): DossierRef[] {
    if (!this.assignments.sessionExists(sessionId)) return []
    return this.assignments.listForSession(sessionId)
  }

  /** Verlauf (#205 AK 6–9); leer, wenn es das Dossier nicht gibt. */
  timeline(dossierId: string): TimelineEntry[] {
    const entries = this.assignments.timeline(dossierId)
    const dossiers = this.assignments.listForSessions(entries.map((e) => e.id))
    return entries.map((entry) => ({ ...entry, dossiers: dossiers.get(entry.id) ?? [] }))
  }

  /**
   * Ordnet eine Sitzung einem Dossier zu (AK 1/3). Eine bestehende Zuordnung
   * gilt als Erfolg. Gibt es Sitzung oder Dossier nicht (mehr), bleibt alles
   * unverändert (PC 3) und das Ergebnis ist `not-found`.
   */
  assign(sessionId: string, dossierId: string): DossierAssignmentResult {
    const changed = this.db.transaction((): boolean | null => {
      if (!this.assignments.sessionExists(sessionId)) return null
      if (!this.assignments.dossierExists(dossierId)) return null
      return this.assignments.assign(sessionId, dossierId, new Date().toISOString())
    })()
    if (changed === null) return { ok: false, reason: 'not-found' }
    if (changed) this.notify()
    return { ok: true }
  }

  /**
   * Löst eine Zuordnung (AK 2/3). Die Sitzung bleibt mit allen Inhalten
   * erhalten (PC 1). Die Zeile verschwindet sofort aus den Dateien (PC 5):
   * `secure_delete` überschreibt sie in der Datenbankdatei, der Checkpoint
   * danach leert den WAL. Eine nicht bestehende Zuordnung gilt als gelöst,
   * solange es Sitzung und Dossier gibt.
   */
  unassign(sessionId: string, dossierId: string): DossierAssignmentResult {
    const removed = this.assignments.unassign(sessionId, dossierId)
    if (removed) {
      try {
        if (!walCheckpointTruncate(this.db)) {
          console.error(
            '[SessionDossierService] WAL-Checkpoint nach dem Lösen blockiert — wird beim nächsten Löschen bzw. Start nachgeholt'
          )
        }
      } catch (error) {
        console.error(
          '[SessionDossierService] WAL-Checkpoint nach dem Lösen fehlgeschlagen:',
          error
        )
      }
      this.notify()
      return { ok: true }
    }
    if (!this.assignments.sessionExists(sessionId) || !this.assignments.dossierExists(dossierId)) {
      return { ok: false, reason: 'not-found' }
    }
    return { ok: true }
  }

  /** Plaketten der Sitzungsliste und Anzahl/Verlauf der Dossiers ändern sich beide. */
  private notify(): void {
    notifySessionsChanged()
    notifyDossiersChanged()
  }
}
