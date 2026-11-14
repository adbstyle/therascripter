import type { Session } from '../../../shared/types'
import { sessionDeletionDetails } from '../../../shared/utils/sessionDeletionDetails'
import { ConfirmDialog } from './ConfirmDialog'

interface DeleteSessionDialogProps {
  session: Session
  onConfirm: () => void
  onCancel: () => void
}

/**
 * Single delete dialog for sessions (dashboard card and review editor).
 * The list names exactly what exists for this session (Issue #202, AK 3).
 */
export function DeleteSessionDialog({
  session,
  onConfirm,
  onCancel
}: DeleteSessionDialogProps): React.JSX.Element {
  const title = session.title.trim()
  const message =
    title.length > 0
      ? `«${title}» und alle zugehörigen Daten unwiderruflich löschen?`
      : 'Diese Transkription und alle zugehörigen Daten unwiderruflich löschen?'

  return (
    <ConfirmDialog
      title="Transkription löschen"
      message={message}
      details={sessionDeletionDetails(session)}
      confirmLabel="Löschen"
      destructive
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  )
}
