import { useCallback, useMemo } from 'react'
import { FileUp, Mic } from 'lucide-react'
import SessionDashboard from '../components/SessionDashboard'
import { ConsentBanner } from '../components/ConsentBanner'
import { PageContainer, PageHeader } from '../components/shell/PageHeader'
import { useNavigation } from '../navigation/navigation'
import { useRecordingState } from '../contexts/recording'
import { useWorkspaceActions } from '../contexts/workspaceActions'

/** Sitzungsliste «Transkriptionen» — Startseite der App. */
export default function SessionsPage(): React.JSX.Element {
  const { navigate } = useNavigation()
  const { isRecording, duration, level, stopRecording, consentDismissed, dismissConsent } =
    useRecordingState()
  const { startRecording, importPdfs, isImporting } = useWorkspaceActions()

  // Die Herkunftskarte merkt sich der Verlaufseintrag dieser Seite: nach dem
  // Schliessen der Sitzung wird sie wieder sichtbar und hervorgehoben.
  const openSession = useCallback(
    (sessionId: string) => navigate({ kind: 'session', sessionId }, { anchorId: sessionId }),
    [navigate]
  )

  const liveRecording = useMemo(
    () => (isRecording ? { duration, level, onStop: stopRecording } : null),
    [isRecording, duration, level, stopRecording]
  )

  return (
    <PageContainer>
      <PageHeader
        title="Transkriptionen"
        actions={
          <>
            <button
              type="button"
              onClick={() => void importPdfs()}
              disabled={isImporting}
              className="flex items-center gap-1.5 rounded-lg border border-border-strong bg-surface-0 px-3 py-1.5 text-sm font-medium text-text-primary transition-colors hover:bg-surface-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-50"
            >
              <FileUp className="h-4 w-4" strokeWidth={1.75} aria-hidden />
              PDF importieren
            </button>
            {!isRecording && (
              <button
                type="button"
                onClick={() => void startRecording()}
                className="flex items-center gap-1.5 rounded-lg bg-recording-solid px-3.5 py-[7px] text-sm font-medium text-white transition-colors hover:bg-recording-solid-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
              >
                <Mic className="h-4 w-4" strokeWidth={2} aria-hidden />
                Aufnahme starten
              </button>
            )}
          </>
        }
      />
      {isRecording && !consentDismissed && <ConsentBanner onDismiss={dismissConsent} />}
      <SessionDashboard onOpenReview={openSession} liveRecording={liveRecording} />
    </PageContainer>
  )
}
