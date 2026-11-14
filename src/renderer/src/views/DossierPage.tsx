import { useNavigation } from '../navigation/navigation'
import { useLiveQuery } from '../hooks/useLiveQuery'
import { useDossierAutosave } from '../hooks/useDossierAutosave'
import { DossierHeader } from '../components/dossier/DossierHeader'
import { DossierHeaderActions } from '../components/dossier/DossierHeaderActions'
import { DossierTimeline } from '../components/dossier/DossierTimeline'
import { DossierMasterDataForm } from '../components/dossier/DossierMasterDataForm'
import { ConsentBanner } from '../components/ConsentBanner'
import { useRecordingState } from '../contexts/recording'
import { useRecordingDossierIds } from '../hooks/useRecordingDossierIds'
import { dossierLabel } from '../utils/dossierFormat'
import { useAmbiguousDossierNames } from '../stores/dossierNames'
import type { Dossier, DossierListItem } from '../../../shared/types/Dossier'

interface DossierPageProps {
  dossierId: string
}

/**
 * Seite eines Patientendossiers (#204): Kopf mit Name und Aktionen, links der
 * Verlauf (`DossierTimeline`, ab #205), rechts die Stammdaten mit Autosave.
 * Zweispaltig, bricht bei schmalem Fenster (~800 px) untereinander um.
 *
 * Der Kopf zeigt den gespeicherten Stand und lädt bei `dossiers:changed`
 * nach; das Formular hält seinen eigenen Entwurf und wird davon nie
 * überschrieben.
 */
export default function DossierPage({ dossierId }: DossierPageProps): React.JSX.Element {
  const { navigate } = useNavigation()
  const dossier = useLiveQuery<Dossier | null>(
    () => window.api.dossiers.get(dossierId),
    [(cb) => window.api.dossiers.onChanged(() => cb())],
    null
  )
  // Anzahl Einträge aus der Übersichtsabfrage (dieselbe Zählregel wie dort)
  const summary = useLiveQuery<DossierListItem | null>(
    async () => (await window.api.dossiers.list()).find((d) => d.id === dossierId) ?? null,
    [
      (cb) => window.api.dossiers.onChanged(() => cb()),
      (cb) => window.api.sessions.onChanged(() => cb())
    ],
    null
  )
  const autosave = useDossierAutosave(dossier.data)
  const { isRecording, consentDismissed, dismissConsent } = useRecordingState()
  // Zeigt der Verlauf die laufende Aufnahme, gehört der Consent-Hinweis hierher
  // wie auf die Sitzungsliste (#206)
  const recordingDossierIds = useRecordingDossierIds()
  const showsLiveCard = isRecording && recordingDossierIds.includes(dossierId)
  const ambiguous = useAmbiguousDossierNames()

  if (dossier.loading && !dossier.data) {
    return (
      <div className="mx-auto w-full max-w-[1240px] p-6">
        <p className="text-sm text-text-tertiary">Wird geladen …</p>
      </div>
    )
  }

  if (!dossier.data) {
    return (
      <div className="mx-auto flex w-full max-w-[1240px] flex-col items-start gap-3 p-6">
        <p role="alert" className="text-sm text-text-secondary">
          {dossier.error
            ? 'Dieses Patientendossier konnte nicht geladen werden.'
            : 'Dieses Patientendossier gibt es nicht mehr.'}
        </p>
        <button
          type="button"
          onClick={() => navigate({ kind: 'dossiers' })}
          className="text-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          Zu allen Patientendossiers
        </button>
      </div>
    )
  }

  // Name für Toasts und Hinweise — bei gleichnamigen Dossiers mit Zusatz
  const dossierName = dossierLabel(dossier.data, ambiguous)
  return (
    <div className="mx-auto flex w-full max-w-[1240px] flex-col gap-5 px-6 pb-6 pt-5">
      <DossierHeader
        dossier={dossier.data}
        entryCount={summary.data?.entryCount ?? (summary.loading ? null : 0)}
        actions={<DossierHeaderActions dossierId={dossierId} dossierName={dossierName} />}
      />
      {showsLiveCard && !consentDismissed && <ConsentBanner onDismiss={dismissConsent} />}
      {/* Zweispaltig (Stammdaten max. 380 px neben dem Verlauf, Prototyp),
          sobald der Inhaltsbereich es zulässt: Verlauf mind. 480 px + Stammdaten
          mind. 300 px + Abstand = 51rem; darunter einspaltig, Stammdaten unten */}
      <div className="@container">
        <div className="grid grid-cols-1 items-start gap-8 @min-[51rem]:grid-cols-[minmax(480px,1fr)_minmax(300px,380px)]">
          <DossierTimeline dossierId={dossierId} dossierName={dossierName} />
          {autosave && <DossierMasterDataForm autosave={autosave} />}
        </div>
      </div>
    </div>
  )
}
