interface DossierTimelineProps {
  dossierId: string
}

/**
 * Verlauf des Patientendossiers (linke Spalte der Dossier-Seite). Platzhalter
 * aus #204: Zuordnen, Verlauf und Leertext mit Anleitung bringt #205 in
 * dieser Datei, Aufnahme und Import aus dem Dossier #206.
 */
export function DossierTimeline({
  dossierId: _dossierId
}: DossierTimelineProps): React.JSX.Element {
  return (
    <section aria-label="Verlauf" className="flex min-w-0 flex-[999_1_560px] flex-col gap-2">
      <div className="rounded-xl border border-dashed border-border-strong px-6 py-8 text-center">
        <p className="text-sm text-text-secondary">
          Noch keine Sitzungen oder PDF-Dokumente zugeordnet.
        </p>
      </div>
    </section>
  )
}
