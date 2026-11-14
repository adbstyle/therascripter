import { dossierListName, pluralize } from './dossierFormat'
import type { DossierDeletePreview, DossierRef } from '../../../shared/types/Dossier'

/** Höchstens so viele andere Dossiers werden mit Namen genannt. */
const MAX_NAMED_DOSSIERS = 3

/** «6 Sitzungen und 2 PDF-Dokumente», «1 PDF-Dokument». */
function describeContents({ sessions, pdfs }: { sessions: number; pdfs: number }): string {
  const parts: string[] = []
  if (sessions > 0) parts.push(pluralize(sessions, 'Sitzung', 'Sitzungen'))
  if (pdfs > 0) parts.push(pluralize(pdfs, 'PDF-Dokument', 'PDF-Dokumente'))
  return parts.join(' und ')
}

/** «im Dossier Hofer, Maria», «in den Dossiers A, B, C und 2 weiteren». */
function describeOtherDossiers(others: DossierRef[]): string {
  if (others.length === 0) return 'in anderen Dossiers'
  if (others.length === 1) return `im Dossier ${dossierListName(others[0])}`
  const named = others.slice(0, MAX_NAMED_DOSSIERS).map(dossierListName)
  const rest = others.length - named.length
  if (rest > 0) return `in den Dossiers ${named.join(', ')} und ${rest} weiteren`
  return `in den Dossiers ${named.slice(0, -1).join(', ')} und ${named[named.length - 1]}`
}

export interface DeleteDossierSummary {
  title: string
  message: string
  sections: { heading: string; items: string[] }[]
  confirmLabel: string
}

/**
 * Was der Dialog nach aktuellem Stand nennt (#204 AK 17, #207 AK 1): was
 * gelöscht wird und was in anderen Dossiers erhalten bleibt — mit Zahlen.
 */
export function summarizeDeletion(preview: DossierDeletePreview): DeleteDossierSummary {
  const exclusiveCount = preview.exclusive.sessions + preview.exclusive.pdfs
  const sharedCount = preview.shared.sessions + preview.shared.pdfs
  const deleted: string[] = []
  if (exclusiveCount > 0) {
    deleted.push(`${describeContents(preview.exclusive)} samt Text und Zusammenfassung`)
  }
  deleted.push('Stammdaten, Diagnosen, Medikation und Notiz')

  const kept: string[] = []
  if (sharedCount > 0) {
    kept.push(
      `${describeContents(preview.shared)}, die auch ${describeOtherDossiers(
        preview.shared.otherDossiers
      )} ${sharedCount === 1 ? 'liegt' : 'liegen'}`
    )
  }
  if (exclusiveCount > 0 || sharedCount > 0) kept.push('Einträge in der Sperrliste')

  return {
    title: `Patientendossier ${preview.displayName} löschen?`,
    message:
      exclusiveCount > 0
        ? 'Das Dossier und alle Inhalte, die nur ihm zugeordnet sind, werden endgültig entfernt.'
        : 'Das Patientendossier wird endgültig entfernt.',
    sections: [
      { heading: 'Gelöscht werden:', items: deleted },
      { heading: 'Erhalten bleiben:', items: kept }
    ].filter((section) => section.items.length > 0),
    confirmLabel:
      exclusiveCount > 0
        ? `Dossier und ${pluralize(exclusiveCount, 'Inhalt', 'Inhalte')} löschen`
        : 'Dossier löschen'
  }
}
