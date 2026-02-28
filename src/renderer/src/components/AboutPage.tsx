import { useCallback, useEffect, useState } from 'react'
import type { AboutInfo } from '../../../shared/types'
import { ConfirmDialog } from './ConfirmDialog'
import { formatBytes } from '../utils/formatBytes'
import AppLogo from './AppLogo'

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

  return (
    <div className="p-8">
      <div className="max-w-lg space-y-6">
        {/* Version */}
        <div>
          <AppLogo size={64} className="mb-3" />
          <h3 className="text-lg font-semibold text-text-primary">
            Therascript v{info?.version ?? '\u2026'}
          </h3>
          <p className="text-sm text-text-tertiary">Open Source (MIT-Lizenz)</p>
        </div>

        <p className="text-sm text-text-secondary">
          Alle Verarbeitung findet komplett lokal auf Ihrem Mac statt.
        </p>

        {/* Storage */}
        <div>
          <h4 className="mb-1 text-sm font-medium text-text-secondary">Speicherverbrauch</h4>
          {info ? (
            <div className="text-sm text-text-secondary">
              <p>App + Modelle: {formatBytes(info.storageModelsBytes)}</p>
              <p>Sitzungsdaten: {formatBytes(info.storageSessionsBytes)}</p>
            </div>
          ) : (
            <p className="text-sm text-text-tertiary">Wird berechnet\u2026</p>
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
                    ? '\u2713 Aktiv'
                    : '\u2717 Nicht aktiv'}
              </p>
            </div>
          ) : (
            <p className="text-sm text-text-tertiary">Wird geladen\u2026</p>
          )}
        </div>

        {/* Data info box */}
        <div className="rounded-lg border border-border bg-surface-1 p-4">
          <h4 className="mb-1 text-sm font-medium text-text-secondary">Daten</h4>
          <p className="text-sm text-text-secondary">
            Sitzungen werden automatisch 30 Tage nach Erstellung gel\u00F6scht.
          </p>
          <p className="mt-1 text-sm text-text-secondary">
            Sie sind verantwortlich, den kopierten Text extern zu sichern.
          </p>
        </div>

        {/* Uninstall button */}
        <button
          className="rounded-lg border border-red-300 px-4 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-950"
          onClick={() => setShowUninstall(true)}
        >
          Therascript vollst\u00E4ndig entfernen
        </button>
      </div>

      {showUninstall && (
        <ConfirmDialog
          title="Therascript vollst\u00E4ndig entfernen"
          message="Alle Daten werden unwiderruflich gel\u00F6scht:"
          details={[
            'ML-Modelle (~4 GB)',
            'Alle Sitzungen und Audiodateien',
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
