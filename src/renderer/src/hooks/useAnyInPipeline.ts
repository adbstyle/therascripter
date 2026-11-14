import type { Session, SessionStatus } from '../../../shared/types'
import { useLiveQuery, type LiveQueryEvent } from './useLiveQuery'

const PIPELINE_STATUSES: SessionStatus[] = ['queued', 'processing']

/** Wartet oder läuft irgendeine Sitzung in der Verarbeitung? */
export function isAnyInPipeline(sessions: readonly Pick<Session, 'status'>[]): boolean {
  return sessions.some((s) => PIPELINE_STATUSES.includes(s.status))
}

const EVENTS: LiveQueryEvent[] = [(callback) => window.api.sessions.onChanged(callback)]

/**
 * Dieselbe Quelle wie die Sitzungsliste (`session:list`), für Seiten, die die
 * Liste nicht ohnehin laden (Verlauf eines Patientendossiers): «Erneut
 * versuchen» ist gesperrt, solange irgendeine Sitzung verarbeitet wird.
 */
export function useAnyInPipeline(): boolean {
  return useLiveQuery(async () => isAnyInPipeline(await window.api.sessions.list()), EVENTS, false)
    .data
}
