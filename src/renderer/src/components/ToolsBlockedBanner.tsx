import { useState } from 'react'
import { ShieldAlert, X } from 'lucide-react'
import { TOOL_FEATURES, type ToolHealthState } from '../../../shared/tool-blocked'

interface ToolsBlockedBannerProps {
  state: ToolHealthState
  checking: boolean
  onOpenGuide: () => void
  onRecheck: () => void
  onDismiss: () => void
}

/**
 * Hinweis, wenn macOS eingebaute Werkzeuge blockiert und Therascript das
 * nicht selbst beheben kann (Issue #168, AK 2–5). Weg ohne Terminal zuerst;
 * den Befehl gibt es erst unter «Hilft das nicht?» (AK 4).
 */
export default function ToolsBlockedBanner({
  state,
  checking,
  onOpenGuide,
  onRecheck,
  onDismiss
}: ToolsBlockedBannerProps): React.JSX.Element {
  const [showCommand, setShowCommand] = useState(false)
  const [copied, setCopied] = useState(false)
  const features = state.tools.map((tool) => TOOL_FEATURES[tool]).join(', ')
  const command = `chmod -R u+w "${state.bundlePath}" && xattr -dr com.apple.quarantine "${state.bundlePath}"`

  const copy = (): void => {
    void navigator.clipboard.writeText(command).then(() => setCopied(true))
  }

  const secondaryButton =
    'titlebar-no-drag rounded-md px-3 py-1.5 text-xs font-semibold text-warning-text-secondary transition-colors hover:text-warning-text disabled:opacity-50'

  return (
    <div role="status" className="border-b border-warning-border bg-warning-bg px-6 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-2 text-sm text-warning-text">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2} aria-hidden="true" />
          <div className="space-y-1">
            <p className="font-semibold">
              macOS blockiert Teile von Therascript. Betroffen: {features}.
            </p>
            <p>
              So beheben Sie es: Laden Sie Therascript neu von der Website, ersetzen Sie die App im
              Ordner «Programme» und bestätigen Sie unter Systemeinstellungen → Datenschutz &amp;
              Sicherheit «Dennoch öffnen». Ihre Transkriptionen bleiben erhalten.
            </p>
          </div>
        </div>
        <button
          aria-label="Hinweis schliessen"
          className="titlebar-no-drag flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-warning-text-secondary transition-colors hover:text-warning-text"
          onClick={onDismiss}
        >
          <X className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2 pl-6">
        <button
          className="titlebar-no-drag rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-primary-hover"
          onClick={onOpenGuide}
        >
          Anleitung öffnen
        </button>
        <button className={secondaryButton} onClick={onRecheck} disabled={checking}>
          {checking ? 'Prüfe…' : 'Erneut prüfen'}
        </button>
        <button
          className={secondaryButton}
          aria-expanded={showCommand}
          onClick={() => setShowCommand((v) => !v)}
        >
          Hilft das nicht?
        </button>
      </div>

      {showCommand && (
        <div className="mt-2 space-y-2 pl-6 text-sm text-warning-text">
          <p>
            Öffnen Sie das Programm «Terminal» (Ordner «Programme» → «Dienstprogramme»), fügen Sie
            diesen Befehl ein, drücken Sie die Eingabetaste und starten Sie Therascript danach neu:
          </p>
          <code className="block break-all rounded-md bg-surface-1 px-3 py-2 font-mono text-xs text-text-primary">
            {command}
          </code>
          <button className={secondaryButton} onClick={copy}>
            {copied ? 'Kopiert' : 'Befehl kopieren'}
          </button>
        </div>
      )}
    </div>
  )
}
