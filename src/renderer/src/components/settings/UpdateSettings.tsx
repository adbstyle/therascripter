import { AlertCircle, CheckCircle2, Download, Loader2 } from 'lucide-react'
import Toggle from '../Toggle'
import { useAppUpdate } from '../../hooks/useAppUpdate'
import { formatBytes } from '../../utils/formatBytes'

/**
 * Einstellungen → Updates (Issues #164, #165): Schalter «Automatische
 * Updates» und Stand des App-Updates. Vor jedem selbst gestarteten Download
 * stehen Version und Grösse da (AK 4).
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
            Neue Versionen werden im Hintergrund geladen und installiert, wenn Sie 10 Minuten nicht
            am Mac arbeiten oder Therascript beenden — nie während einer Aufnahme oder Verarbeitung.
          </p>
        ) : (
          <p className="rounded-lg border border-warning-border bg-warning-bg px-3 py-2 text-sm text-warning-text">
            Neue Versionen werden nur angezeigt. Fehlerbehebungen kommen erst an, wenn Sie sie hier
            selbst herunterladen und installieren.
          </p>
        )}
      </section>

      {/* ── Stand (#164) ── */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-text-primary">
          Therascript {state.currentVersion}
        </h3>

        {state.phase === 'idle' && (
          <div className="flex items-center gap-3">
            <CheckCircle2 className="h-5 w-5 text-success" strokeWidth={1.75} aria-hidden="true" />
            <span className="text-sm text-text-secondary">Therascript ist aktuell.</span>
          </div>
        )}

        {state.phase === 'available' && (
          <div className="space-y-3">
            <p className="text-sm text-text-secondary">
              Version {state.version} ist verfügbar{size ? ` (Download ${size})` : ''}.
            </p>
            <button className={busyButton} onClick={download}>
              <span className="flex items-center gap-2">
                <Download className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
                Version {state.version} herunterladen{size ? ` (${size})` : ''}
              </span>
            </button>
          </div>
        )}

        {state.phase === 'downloading' &&
          (state.manualDownload ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm text-text-secondary">
                <span>
                  Version {state.version} wird geladen{size ? ` (${size})` : ''}…
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
                Version {state.version} wird im Hintergrund vorbereitet.
              </span>
            </div>
          ))}

        {state.phase === 'ready' && (
          <div className="space-y-3">
            <p className="text-sm text-text-secondary">
              Version {state.version} liegt bereit. Therascript startet beim Installieren neu.
              {state.autoUpdate &&
                ' Ohne Ihr Zutun wird sie installiert, wenn Sie 10 Minuten nicht am Mac arbeiten oder Therascript beenden.'}
            </p>
            {!state.installPending && (
              <button className={busyButton} onClick={() => void install()}>
                Version {state.version} installieren
              </button>
            )}
          </div>
        )}

        {state.phase === 'unsupported' && (
          <div className="space-y-3">
            <p className="text-sm text-text-secondary">
              Version {state.version} ist verfügbar. {state.unsupportedReason} Die Anleitung zeigt,
              wie Sie die neue Version von Hand installieren.
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

        {(state.phase === 'idle' || state.phase === 'available') && (
          <button className={secondaryButton} onClick={() => void check()} disabled={checking}>
            {checking ? 'Prüfe…' : 'Nach Updates suchen'}
          </button>
        )}
      </section>
    </div>
  )
}
