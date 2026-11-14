import type { RecentEntry, RecentTouchTarget } from '../Recent'

/** «Zuletzt geöffnet» (#213). */
export interface RecentApi {
  /** Höchstens acht Einträge, eine laufende Aufnahme zuerst. */
  list(): Promise<RecentEntry[]>
  /** Merkt ein geöffnetes Dossier bzw. eine geöffnete Sitzung. */
  touch(target: RecentTouchTarget): Promise<void>
  /** Die Liste hat sich geändert (Öffnen, Aufnahmestart). */
  onChanged(callback: () => void): () => void
}
