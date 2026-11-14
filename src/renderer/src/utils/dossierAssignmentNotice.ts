/**
 * Hinweise, wenn eine aus einem Patientendossier heraus gestartete Aufnahme
 * oder ein dort importiertes PDF dem Dossier nicht zugeordnet werden konnte
 * (#206 AK 2). Sie nennen Zeitpunkt bzw. Titel und das Dossier und den Weg,
 * die Zuordnung nachzuholen.
 */

const LATER = 'Sie können das in der Liste «Transkriptionen» über «Dossier zuordnen» nachholen.'

/** «14.11.2026, 10:05» — Zeitpunkt des Aufnahmestarts in Lokalzeit. */
export function formatRecordingStart(date: Date): string {
  const pad = (n: number): string => n.toString().padStart(2, '0')
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}, ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`
}

/** «dem Patientendossier «Hofer, Lukas»» bzw. ohne bekannten Namen «dem Patientendossier». */
function dossierPhrase(dossierName: string | null): string {
  return dossierName ? `dem Patientendossier «${dossierName}»` : 'dem Patientendossier'
}

export function recordingNotAssignedNotice(startedAt: Date, dossierName: string | null): string {
  return `Die Aufnahme vom ${formatRecordingStart(startedAt)} läuft, konnte ${dossierPhrase(
    dossierName
  )} aber nicht zugeordnet werden. ${LATER}`
}

export function pdfsNotAssignedNotice(titles: string[], dossierName: string | null): string {
  const named = titles.map((t) => `«${t.trim() || 'Ohne Titel'}»`).join(', ')
  return titles.length === 1
    ? `Das PDF-Dokument ${named} wurde importiert, konnte ${dossierPhrase(
        dossierName
      )} aber nicht zugeordnet werden. ${LATER}`
    : `Die PDF-Dokumente ${named} wurden importiert, konnten ${dossierPhrase(
        dossierName
      )} aber nicht zugeordnet werden. ${LATER}`
}
