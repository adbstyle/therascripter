import type Database from 'better-sqlite3'
import {
  RecentRepository,
  RECENT_LIMIT,
  type RecentTarget
} from '../db/repositories/RecentRepository'
import { DossierRepository } from '../db/repositories/DossierRepository'
import { SessionRepository } from '../db/repositories/SessionRepository'
import { notifyRecentChanged } from './ChangeEvents'
import type { RecentEntry } from '../../shared/types/Recent'

export interface RecentServiceDeps {
  /** Sitzung, die gerade aufgenommen wird (recording-handlers), sonst null. */
  getActiveSessionId?: () => string | null
}

/**
 * «Zuletzt geöffnet» (#213). Gespeichert wird beim Öffnen eines Dossiers
 * oder einer Sitzung (Renderer, `recent:touch`) und beim Start einer
 * Aufnahme (recording-handlers) — importierte PDFs nicht, die wurden nicht
 * geöffnet. Liegt in SQLite und übersteht so einen Neustart (PC 1).
 */
export class RecentService {
  private recent: RecentRepository
  private dossiers: DossierRepository
  private sessions: SessionRepository
  private getActiveSessionId: () => string | null

  constructor(db: Database.Database, deps: RecentServiceDeps = {}) {
    this.recent = new RecentRepository(db)
    this.dossiers = new DossierRepository(db)
    this.sessions = new SessionRepository(db)
    this.getActiveSessionId = deps.getActiveSessionId ?? ((): null => null)
  }

  /**
   * Merkt einen geöffneten Eintrag. Gibt es ihn nicht (mehr) — gelöscht
   * oder im Löschen —, passiert nichts: kein Verweis auf Gelöschtes.
   */
  touch(target: RecentTarget, now?: Date): void {
    const exists =
      target.kind === 'dossier'
        ? this.dossiers.findRefById(target.id) !== null
        : this.sessions.findById(target.id) !== null
    if (!exists) return
    this.recent.touch(target, now)
    notifyRecentChanged()
  }

  /**
   * Höchstens RECENT_LIMIT Einträge, das zuletzt geöffnete zuerst — eine
   * laufende Aufnahme vor allen anderen (AK 2), auch wenn sie inzwischen aus
   * den acht jüngsten herausgefallen ist.
   */
  list(): RecentEntry[] {
    const activeId = this.getActiveSessionId()
    const entries: RecentEntry[] = []
    const active = activeId ? this.sessions.findById(activeId) : null
    if (active) entries.push({ kind: 'session', session: active, recording: true })

    for (const row of this.recent.list(RECENT_LIMIT)) {
      if (entries.length >= RECENT_LIMIT) break
      if (row.dossierId) {
        const dossier = this.dossiers.findRefById(row.dossierId)
        if (dossier) entries.push({ kind: 'dossier', dossier })
      } else if (row.sessionId && row.sessionId !== active?.id) {
        const session = this.sessions.findById(row.sessionId)
        if (session) entries.push({ kind: 'session', session, recording: false })
      }
    }
    return entries
  }
}
