import { useCallback, useEffect, useState } from 'react'
import type { AboutInfo } from '../../../shared/types'
import { ConfirmDialog } from './ConfirmDialog'
import { formatBytes } from '../utils/formatBytes'
import AppLogo from './AppLogo'
import {
  MODEL_ACKNOWLEDGMENTS,
  SOFTWARE_ACKNOWLEDGMENTS,
  type Acknowledgment
} from '../constants/acknowledgments'

export default function AboutPage(): React.JSX.Element {
  const [info, setInfo] = useState<AboutInfo | null>(null)
  const [showUninstall, setShowUninstall] = useState(false)

  useEffect(() => {
    window.api.system.aboutInfo().then(setInfo)
  }, [])

  const handleUninstall = useCallback(async () => {
    setShowUninstall(false)
    await window.api.system.uninstall()
  }, [])

  const handleOpenInFinder = useCallback(() => {
    if (info?.dataDir) {
      window.api.system.openInFinder(info.dataDir)
    }
  }, [info?.dataDir])

  return (
    <div className="p-8">
      <div className="max-w-lg space-y-6">
        {/* Version / Logo */}
        <div>
          <AppLogo size={64} className="mb-3" />
          <h3 className="text-lg font-semibold text-text-primary">
            TheraScript v{info?.version ?? '…'}
          </h3>
          <p className="text-sm text-text-tertiary">Open Source (MIT-Lizenz)</p>
        </div>

        <div className="space-y-2 text-sm text-text-secondary">
          <p>
            Alle Verarbeitung findet auf Ihrem Mac statt. Aufnahmen, Transkripte, PDFs und
            Zusammenfassungen übermittelt TheraScript nie.
          </p>
          <p>
            Mit dem Internet verbindet sich TheraScript nur, um Sprachmodelle herunterzuladen (bei
            der Ersteinrichtung, beim Hinzufügen eines Modells und bei Modell-Updates), um nach
            neuen Versionen zu suchen (beim Start und alle 4 Stunden) und um neue Versionen
            herunterzuladen (automatisch oder auf Klick, siehe Einstellungen → Updates). Dabei sehen
            die Anbieter Cloudflare und GitHub Ihre IP-Adresse, den Zeitpunkt und die abgerufene
            Datei. TheraScript sendet kein Konto, keine Kennung und keine Nutzungsdaten. Nach der
            Ersteinrichtung funktioniert TheraScript auch ohne Internet.
          </p>
        </div>

        {/* Pseudonymisierung — Erklärung der DSGVO-Terminologie (Issue #84 / Story H) */}
        <section
          id="pseudonymisierung"
          className="rounded-lg border border-border bg-surface-1 p-4"
        >
          <h4 className="mb-2 text-sm font-medium text-text-primary">
            Wie TheraScript Daten schützt
          </h4>
          <p className="mb-2 text-sm text-text-secondary">
            Erkannte personenbezogene Angaben werden durch typisierte Platzhalter ersetzt:{' '}
            <span className="whitespace-nowrap">[PERSON 1]</span>,{' '}
            <span className="whitespace-nowrap">[ORT 1]</span>,{' '}
            <span className="whitespace-nowrap">[DATUM 1]</span>.
          </p>
          <p className="mb-2 text-sm text-text-secondary">
            DSGVO-rechtlich heisst das <span className="font-medium">Pseudonymisierung</span> — die
            Originaldaten bleiben in Ihrem lokalen Backup vorhanden, sind aber im exportierten Text
            nicht mehr enthalten.
          </p>
          <p className="text-sm text-text-secondary">
            Echte Anonymisierung wäre, die Originale zu löschen — das machen wir bewusst nicht,
            damit Sie Korrekturen rückgängig machen können.
          </p>
        </section>

        {/* Quellcode */}
        <div>
          <h4 className="mb-1 text-sm font-medium text-text-secondary">Quellcode</h4>
          <button
            className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-2"
            onClick={() => window.open('https://github.com/adbstyle/therascripter', '_blank')}
          >
            Auf GitHub ansehen
          </button>
        </div>

        {/* App-Datenverzeichnis */}
        <div>
          <h4 className="mb-1 text-sm font-medium text-text-secondary">App-Datenverzeichnis</h4>
          <div className="flex items-center gap-3">
            <p className="min-w-0 flex-1 truncate text-sm text-text-secondary">
              {info?.dataDir ?? '…'}
            </p>
            <button
              className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-2 disabled:opacity-50"
              onClick={handleOpenInFinder}
              disabled={!info?.dataDir}
            >
              Öffnen
            </button>
          </div>
        </div>

        {/* Speicherverbrauch */}
        <div>
          <h4 className="mb-1 text-sm font-medium text-text-secondary">Speicherverbrauch</h4>
          {info ? (
            <div className="text-sm text-text-secondary">
              <p>App + Modelle: {formatBytes(info.storageModelsBytes)}</p>
              <p>Transkriptionsdaten: {formatBytes(info.storageSessionsBytes)}</p>
            </div>
          ) : (
            <p className="text-sm text-text-tertiary">Wird berechnet…</p>
          )}
        </div>

        {/* System */}
        <div>
          <h4 className="mb-1 text-sm font-medium text-text-secondary">System</h4>
          {info ? (
            <div className="text-sm text-text-secondary">
              <p>macOS: {info.osVersion}</p>
              <p>Chip: {info.chip}</p>
              <p>RAM: {info.totalMemoryGB} GB</p>
              <p>
                FileVault:{' '}
                {info.fileVaultActive === null
                  ? 'Unbekannt'
                  : info.fileVaultActive
                    ? '✓ Aktiv'
                    : '✗ Nicht aktiv'}
              </p>
            </div>
          ) : (
            <p className="text-sm text-text-tertiary">Wird geladen…</p>
          )}
        </div>

        {/* Daten info box */}
        <div className="rounded-lg border border-border bg-surface-1 p-4">
          <h4 className="mb-1 text-sm font-medium text-text-secondary">Daten</h4>
          <p className="text-sm text-text-secondary">
            Transkriptionen werden automatisch 30 Tage nach Erstellung gelöscht.
          </p>
          <p className="mt-1 text-sm text-text-secondary">
            Sie sind verantwortlich, den kopierten Text extern zu sichern.
          </p>
        </div>

        {/* Acknowledgments — mit Lizenzhinweisen (MIT/Apache verlangen den Text bei Weitergabe) */}
        <div>
          <h4 className="mb-2 text-sm font-medium text-text-secondary">Acknowledgments</h4>
          <AcknowledgmentList title="Software" items={SOFTWARE_ACKNOWLEDGMENTS} />
          <AcknowledgmentList title="Modelle" items={MODEL_ACKNOWLEDGMENTS} />
        </div>

        {/* Uninstall button */}
        <button
          className="rounded-lg border border-error-border px-4 py-2 text-sm font-medium text-error-text transition-colors hover:bg-error-bg"
          onClick={() => setShowUninstall(true)}
        >
          TheraScript vollständig entfernen
        </button>
      </div>

      {showUninstall && (
        <ConfirmDialog
          title="TheraScript vollständig entfernen"
          message="Alle Daten werden unwiderruflich gelöscht:"
          details={[
            'ML-Modelle (mehrere GB)',
            'Alle Transkriptionen und Audiodateien',
            'Sperrliste',
            'Einstellungen'
          ]}
          confirmLabel="Entfernen"
          destructive
          onConfirm={handleUninstall}
          onCancel={() => setShowUninstall(false)}
        />
      )}
    </div>
  )
}

function AcknowledgmentList({
  title,
  items
}: {
  title: string
  items: Acknowledgment[]
}): React.JSX.Element {
  return (
    <div className="mb-4">
      <p className="mb-1.5 text-xs font-medium tracking-wide text-text-tertiary uppercase">
        {title}
      </p>
      <div className="space-y-2">
        {items.map((item) => (
          <AcknowledgmentItem key={item.name} item={item} />
        ))}
      </div>
    </div>
  )
}

// Lizenztext erst beim Aufklappen rendern — sonst hängen alle Texte (~40 KB)
// bei jedem Besuch der Über-Seite im DOM.
function AcknowledgmentItem({ item }: { item: Acknowledgment }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <details
      className="rounded-lg border border-border bg-surface-1"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="cursor-pointer px-3 py-2 text-sm">
        <span className="font-medium text-text-secondary">{item.name}</span>
        <span className="text-text-tertiary">
          {' '}
          — {item.description} · {item.license}
        </span>
      </summary>
      {open && (
        <pre className="max-h-64 overflow-y-auto border-t border-border px-3 py-2 text-xs whitespace-pre-wrap text-text-tertiary">
          {item.notice}
        </pre>
      )}
    </details>
  )
}
