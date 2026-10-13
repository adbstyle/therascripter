import { AlertCircle, CheckCircle2, Download, Loader2 } from 'lucide-react'
import Toggle from '../Toggle'
import { useAppUpdate } from '../../hooks/useAppUpdate'
import { updateTitle } from '../../../../shared/utils/updateTitle'
import { formatBytes } from '../../utils/formatBytes'
import type { AppUpdateState } from '../../../../shared/types/AppUpdate'

/**
 * Einstellungen → Updates (Issues #164, #165, #167): Schalter «Automatische
 * Updates» und Stand des Updates. App und Modelle sind ein Vorgang; vor
 * jedem selbst gestarteten Download stehen alle Teile, die gesamte Grösse
 * und der nötige Speicherplatz da (AK 3, NFR 1).
 */
export default function UpdateSettings(): React.JSX.Element {
  const {
    state,
    checking,
    check,
    download,
    cancelDownload,
    install,
    setAutoUpdate,
    openInstallGuide
  } = useAppUpdate()

  if (!state) {
    return <div className="p-8 text-sm text-text-tertiary">Wird geladen…</div>
  }

  const title = updateTitle(state)
  const size = state.sizeBytes ? formatBytes(state.sizeBytes) : null
  const busyButton =
    'titlebar-no-drag rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-hover disabled:opacity-50'
  const secondaryButton =
    'titlebar-no-drag rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-2 disabled:opacity-50'

  return (
    <div className="max-w-xl space-y-8 p-8">
      {/* ── Automatische Updates (#165) ── */}
      <section className="space-y-2">
        <div className="flex items-center justify-between gap-4">
          <h3 className="text-sm font-semibold text-text-primary">Automatische Updates</h3>
          <Toggle
            checked={state.autoUpdate}
            onChange={setAutoUpdate}
            label="Automatische Updates"
          />
        </div>
        {state.autoUpdate ? (
          <p className="text-sm text-text-secondary">
            Neue Versionen und neue Fassungen der Sprachmodelle werden im Hintergrund geladen und
            installiert, wenn Sie 10 Minuten nicht am Mac arbeiten oder Therascript beenden — nie
            während einer Aufnahme oder Verarbeitung.
          </p>
        ) : (
          <p className="rounded-lg border border-warning-border bg-warning-bg px-3 py-2 text-sm text-warning-text">
            Updates werden nur angezeigt. Fehlerbehebungen und verbesserte Modelle kommen erst an,
            wenn Sie sie hier selbst herunterladen und installieren. Ein Update lässt sich
            verschieben, aber nicht überspringen.
          </p>
        )}
      </section>

      {/* ── Stand (#164, #167) ── */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-text-primary">
          Therascript {state.currentVersion}
        </h3>

        {state.phase === 'idle' &&
          (state.checkFailed ? (
            <p className="flex items-start gap-2 text-sm text-text-secondary">
              <AlertCircle
                className="mt-0.5 h-4 w-4 shrink-0 text-warning-text"
                strokeWidth={2}
                aria-hidden="true"
              />
              Die Suche nach Updates ist nicht gelungen. Bitte prüfen Sie die Internetverbindung und
              versuchen Sie es später erneut.
            </p>
          ) : state.checkedAt ? (
            <div className="flex items-center gap-3">
              <CheckCircle2
                className="h-5 w-5 text-success"
                strokeWidth={1.75}
                aria-hidden="true"
              />
              <span className="text-sm text-text-secondary">Therascript ist aktuell.</span>
            </div>
          ) : (
            <p className="text-sm text-text-secondary">Noch nicht nach Updates gesucht.</p>
          ))}

        {state.phase === 'available' && (
          <div className="space-y-3">
            <p className="text-sm text-text-secondary">{title} ist verfügbar.</p>
            <UpdateParts state={state} />
            {state.diskNeedBytes !== null && (
              <p className="text-xs text-text-tertiary">
                Zum Herunterladen und Bereitstellen braucht es ca.{' '}
                {formatBytes(state.diskNeedBytes)} freien Speicherplatz.
              </p>
            )}
            <button className={busyButton} onClick={download}>
              <span className="flex items-center gap-2">
                <Download className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
                {title} herunterladen{size ? ` (${size})` : ''}
              </span>
            </button>
          </div>
        )}

        {state.phase === 'downloading' &&
          (state.manualDownload ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm text-text-secondary">
                <span>
                  {title} wird geladen{size ? ` (${size})` : ''}…
                </span>
                <span>{state.progress ?? 0} %</span>
              </div>
              <div
                className="h-2 overflow-hidden rounded-full bg-surface-2"
                role="progressbar"
                aria-valuenow={state.progress ?? 0}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Download-Fortschritt"
              >
                <div
                  className="h-full rounded-full bg-primary transition-all duration-300"
                  style={{ width: `${state.progress ?? 0}%` }}
                />
              </div>
              <button className={secondaryButton} onClick={cancelDownload}>
                Abbrechen
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <Loader2
                className="h-4 w-4 animate-spin text-primary"
                strokeWidth={2}
                aria-hidden="true"
              />
              <span className="text-sm text-text-secondary">
                {title} wird im Hintergrund vorbereitet.
              </span>
            </div>
          ))}

        {state.phase === 'ready' && (
          <div className="space-y-3">
            <p className="text-sm text-text-secondary">
              {title} liegt bereit. Therascript startet beim Installieren neu.
              {state.autoUpdate &&
                ' Ohne Ihr Zutun wird es installiert, wenn Sie 10 Minuten nicht am Mac arbeiten oder Therascript beenden.'}
            </p>
            <UpdateParts state={state} />
            {!state.installPending && (
              <button className={busyButton} onClick={() => void install()}>
                {title} installieren
              </button>
            )}
          </div>
        )}

        {state.manualVersion && (
          <div className="space-y-3">
            <p className="text-sm text-text-secondary">
              Version {state.manualVersion} ist verfügbar. {state.unsupportedReason} Die Anleitung
              zeigt, wie Sie die neue Version von Hand installieren.
            </p>
            <button className={secondaryButton} onClick={openInstallGuide}>
              Anleitung öffnen
            </button>
          </div>
        )}

        {state.message && (
          <p
            role="status"
            className="flex items-start gap-2 rounded-lg border border-warning-border bg-warning-bg px-3 py-2 text-sm text-warning-text"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2} aria-hidden="true" />
            {state.message}
          </p>
        )}

        {(state.phase === 'idle' ||
          state.phase === 'available' ||
          state.phase === 'unsupported') && (
          <button className={secondaryButton} onClick={() => void check()} disabled={checking}>
            {checking ? 'Prüfe…' : 'Nach Updates suchen'}
          </button>
        )}
      </section>
    </div>
  )
}

/** Teile des Updates mit Grösse und Summe (AK 3); nur nötig, wenn Modelle dabei sind. */
function UpdateParts({ state }: { state: AppUpdateState }): React.JSX.Element | null {
  if (state.models.length === 0) return null
  return (
    <ul className="space-y-1 rounded-lg border border-border px-3 py-2 text-sm text-text-secondary">
      {state.version && state.appSizeBytes !== null && (
        <PartRow label={`Therascript ${state.version}`} sizeBytes={state.appSizeBytes} />
      )}
      {state.models.map((model) => (
        <PartRow
          key={model.id}
          label={`${model.label} (${model.kind === 'new' ? 'neu für diese Version' : 'neue Fassung'})`}
          sizeBytes={model.sizeBytes}
        />
      ))}
      {state.sizeBytes !== null && (
        <li className="flex justify-between gap-4 border-t border-border pt-1 font-medium text-text-primary">
          <span>Gesamt</span>
          <span className="tabular-nums">{formatBytes(state.sizeBytes)}</span>
        </li>
      )}
    </ul>
  )
}

function PartRow({ label, sizeBytes }: { label: string; sizeBytes: number }): React.JSX.Element {
  return (
    <li className="flex justify-between gap-4">
      <span>{label}</span>
      <span className="shrink-0 tabular-nums">{formatBytes(sizeBytes)}</span>
    </li>
  )
}
