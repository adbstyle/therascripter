import type { Session } from '../types/Session'

export type SessionDeletionInput = Pick<
  Session,
  | 'type'
  | 'audioPath'
  | 'pdfPath'
  | 'transcriptPath'
  | 'diarizationPath'
  | 'alignedTranscriptPath'
  | 'extractedPath'
  | 'anonymizedPath'
  | 'summary'
> &
  Partial<Pick<Session, 'reviewAt'>>

/**
 * What deleting this session removes, in the words of the delete dialog
 * (Issue #202, AK 3). Lists only what exists for this session right now —
 * e.g. the recording only until the 24-hour source-file cleanup removed it.
 * Works on the list projection of a session (no entity map needed): the
 * pseudonymization exists exactly when the pseudonymized document exists.
 * Search data (Epic #192) is named once the session was processed — from
 * then on the search index holds its texts.
 * Blocklist entries and backups of the Mac are deliberately not mentioned:
 * deleting a session does not touch them (Out of Scope 5/6).
 */
export function sessionDeletionDetails(session: SessionDeletionInput): string[] {
  const details: string[] = []
  const isAudio = session.type === 'audio'

  if (isAudio && session.audioPath) details.push('Audioaufnahme')
  if (!isAudio && session.pdfPath) details.push('Original-PDF')

  if (session.anonymizedPath) {
    details.push(
      isAudio
        ? 'Transkript inklusive Ihrer Bearbeitungen'
        : 'Text des PDF-Dokuments inklusive Ihrer Bearbeitungen'
    )
    details.push('Pseudonymisierung samt den Originaltexten aller Platzhalter')
  }

  if (
    session.transcriptPath ||
    session.diarizationPath ||
    session.alignedTranscriptPath ||
    session.extractedPath
  ) {
    details.push('Zwischenergebnisse der Verarbeitung')
  }

  // Epic #192 (#209): die Suche bereitet jede fertig verarbeitete Sitzung auf
  // (Titel, Zusammenfassung, Text im Klartext). Massgeblich ist, ob die
  // Verarbeitung einmal abgeschlossen wurde — reviewAt wird nie zurückgesetzt.
  if (session.reviewAt) details.push('Für die Suche aufbereitete Texte')

  const hasSummary = typeof session.summary === 'string' && session.summary.trim().length > 0
  details.push(hasSummary ? 'Titel und Zusammenfassung' : 'Titel')

  return details
}
