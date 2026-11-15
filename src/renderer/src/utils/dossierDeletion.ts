import { dossierFullDistinction, dossierListName, pluralize } from './dossierFormat'
import type { Dossier, DossierDeletePreview, DossierRef } from '../../../shared/types/Dossier'

/** Höchstens so viele andere Dossiers werden mit Namen genannt. */
const MAX_NAMED_DOSSIERS = 3

/**
 * Name eines anderen Dossiers; gleichnamige mit «ID · Geburtsdatum» in
 * Klammern (wie im Löschdialog einer Sitzung), ohne beides mit «angelegt am
 * … · N Einträge».
 */
function otherName(ref: DossierRef, ambiguous: ReadonlySet<string>): string {
  const distinction = dossierFullDistinction(ref, ambiguous)
  return distinction ? `${dossierListName(ref)} (${distinction})` : dossierListName(ref)
}

/** «6 Sitzungen und 2 PDF-Dokumente», «1 PDF-Dokument». */
function describeContents({ sessions, pdfs }: { sessions: number; pdfs: number }): string {
  const parts: string[] = []
  if (sessions > 0) parts.push(pluralize(sessions, 'Sitzung', 'Sitzungen'))
  if (pdfs > 0) parts.push(pluralize(pdfs, 'PDF-Dokument', 'PDF-Dokumente'))
  return parts.join(' und ')
}

/**
 * «im Dossier Hofer, Maria», «in den Dossiers Hofer, Maria; Keller, Nina und
 * 2 weiteren» — Semikolon, weil die Namen selbst ein Komma tragen.
 */
function describeOtherDossiers(others: DossierRef[], ambiguous: ReadonlySet<string>): string {
  if (others.length === 0) return 'in anderen Dossiers'
  if (others.length === 1) return `im Dossier ${otherName(others[0], ambiguous)}`
  const named = others.slice(0, MAX_NAMED_DOSSIERS).map((ref) => otherName(ref, ambiguous))
  const rest = others.length - named.length
  if (rest > 0) return `in den Dossiers ${named.join('; ')} und ${rest} weiteren`
  return `in den Dossiers ${named.slice(0, -1).join('; ')} und ${named[named.length - 1]}`
}

export interface DeleteDossierSummary {
  title: string
  message: string
  sections: { heading: string; items: string[] }[]
  confirmLabel: string
}

/**
 * Relativsatz zu den geteilten Inhalten mit passendem Genus und Numerus:
 * «1 Sitzung, die … liegt», «1 PDF-Dokument, das … liegt», sonst (mehrere
 * oder gemischt) «…, die … liegen».
 */
function sharedClause(
  shared: DossierDeletePreview['shared'],
  ambiguous: ReadonlySet<string>
): string {
  const count = shared.sessions + shared.pdfs
  const pronoun = count === 1 && shared.pdfs === 1 ? 'das' : 'die'
  const verb = count === 1 ? 'liegt' : 'liegen'
  return `${describeContents(shared)}, ${pronoun} auch ${describeOtherDossiers(
    shared.otherDossiers,
    ambiguous
  )} ${verb}`
}

/**
 * Was der Dialog nach aktuellem Stand nennt (#204 AK 17, #207 AK 1): was
 * gelöscht wird und was in anderen Dossiers erhalten bleibt — mit Zahlen.
 * `ambiguous`: mehrfach vergebene Namen (`stores/dossierNames`) — solche
 * Dossiers nennt der Dialog mit «ID · Geburtsdatum» (ohne beides «angelegt
 * am … · N Einträge»), das zu löschende (`self`) schon im Titel.
 */
export function summarizeDeletion(
  preview: DossierDeletePreview,
  ambiguous: ReadonlySet<string> = new Set(),
  self?: Dossier | null
): DeleteDossierSummary {
  const exclusiveCount = preview.exclusive.sessions + preview.exclusive.pdfs
  const sharedCount = preview.shared.sessions + preview.shared.pdfs
  // Gleichnamige Dossiers schon im Titel unterscheiden (Sichtprüfung)
  const distinction = self
    ? dossierFullDistinction(self, ambiguous, {
        createdAt: self.createdAt,
        entryCount: exclusiveCount + sharedCount
      })
    : ''
  const name = distinction ? `${preview.displayName} (${distinction})` : preview.displayName
  const deleted: string[] = []
  if (exclusiveCount > 0) {
    deleted.push(`${describeContents(preview.exclusive)} samt Text und Zusammenfassung`)
  }
  // Suchdaten nur, soweit es sie gibt (Epic EK 22: keine unzutreffende Aussage)
  // (gleicher Wortlaut wie im Löschdialog einer Sitzung, sessionDeletionDetails)
  if (preview.search.exclusiveSearchable > 0) deleted.push('Für die Suche aufbereitete Texte')
  deleted.push('Stammdaten, Diagnosen, Medikation und Notiz')
  if (preview.search.recentQueries > 0) {
    deleted.push(
      `${pluralize(
        preview.search.recentQueries,
        'letzte Suchanfrage',
        'letzte Suchanfragen'
      )} mit Namen oder ID dieses Patientendossiers`
    )
  }

  const kept: string[] = []
  if (sharedCount > 0) {
    kept.push(sharedClause(preview.shared, ambiguous))
  }
  if (exclusiveCount > 0 || sharedCount > 0) kept.push('Einträge in der Sperrliste')

  return {
    title: `Patientendossier ${name} löschen?`,
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
