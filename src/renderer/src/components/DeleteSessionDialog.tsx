import type { Session } from '../../../shared/types'
import type { DossierRef } from '../../../shared/types/Dossier'
import { dossierIdentification, dossierListName } from '../utils/dossierFormat'
import { sessionDeletionDetails } from '../../../shared/utils/sessionDeletionDetails'
import { ConfirmDialog } from './ConfirmDialog'

interface DeleteSessionDialogProps {
  session: Session
  /**
   * Issue #203 — title as the chosen view shows it (Klartext resolves
   * placeholders). Defaults to the stored, pseudonymized title.
   */
  displayTitle?: string
  /**
   * #205 AK 23 — Patientendossiers, aus denen die Sitzung beim Löschen
   * verschwindet (Stand beim Öffnen bzw. laufend aktualisiert).
   */
  dossiers?: DossierRef[]
  onConfirm: () => void
  onCancel: () => void
}

/**
 * Single delete dialog for sessions (dashboard card and review editor).
 * The list names exactly what exists for this session (Issue #202, AK 3),
 * plus the patient dossiers it disappears from (#205 AK 23).
 */
export function DeleteSessionDialog({
  session,
  displayTitle,
  dossiers = [],
  onConfirm,
  onCancel
}: DeleteSessionDialogProps): React.JSX.Element {
  const title = (displayTitle ?? session.title).trim()
  const message =
    title.length > 0
      ? `«${title}» und alle zugehörigen Daten unwiderruflich löschen?`
      : 'Diese Transkription und alle zugehörigen Daten unwiderruflich löschen?'

  return (
    <ConfirmDialog
      title="Transkription löschen"
      message={message}
      details={sessionDeletionDetails(session)}
      sections={[
        {
          heading:
            dossiers.length === 1
              ? 'Verschwindet aus dem Patientendossier:'
              : 'Verschwindet aus den Patientendossiers:',
          items: dossiers.map((d) => {
            const identification = dossierIdentification(d)
            return identification ? `${dossierListName(d)} (${identification})` : dossierListName(d)
          })
        }
      ]}
      confirmLabel="Löschen"
      destructive
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  )
}
