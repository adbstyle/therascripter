import { useCallback, useEffect, useState } from 'react'
import type { AboutInfo } from '../../../shared/types'
import { ConfirmDialog } from './ConfirmDialog'
import { formatBytes } from '../utils/formatBytes'

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
          <h3 className="text-lg font-semibold text-gray-900">
            Therascript v{info?.version ?? '…'}
          </h3>
          <p className="text-sm text-gray-500">Open Source (MIT-Lizenz)</p>
        </div>

        <p className="text-sm text-gray-600">
          Alle Verarbeitung findet komplett lokal auf Ihrem Mac statt.
        </p>

        {/* Storage */}
        <div>
          <h4 className="mb-1 text-sm font-medium text-gray-700">Speicherverbrauch</h4>
          {info ? (
            <div className="text-sm text-gray-600">
              <p>App + Modelle: {formatBytes(info.storageModelsBytes)}</p>
              <p>Sitzungsdaten: {formatBytes(info.storageSessionsBytes)}</p>
            </div>
          ) : (
            <p className="text-sm text-gray-400">Wird berechnet…</p>
          )}
        </div>

        {/* System */}
        <div>
          <h4 className="mb-1 text-sm font-medium text-gray-700">System</h4>
          {info ? (
            <div className="text-sm text-gray-600">
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
            <p className="text-sm text-gray-400">Wird geladen…</p>
          )}
        </div>

        {/* Data info box */}
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
          <h4 className="mb-1 text-sm font-medium text-gray-700">Daten</h4>
          <p className="text-sm text-gray-600">
            Sitzungen werden automatisch 30 Tage nach Erstellung gelöscht.
          </p>
          <p className="mt-1 text-sm text-gray-600">
            Sie sind verantwortlich, den kopierten Text extern zu sichern.
          </p>
        </div>

        {/* Uninstall button */}
        <button
          className="rounded-lg border border-red-300 px-4 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50"
          onClick={() => setShowUninstall(true)}
        >
          Therascript vollständig entfernen
        </button>
      </div>

      {showUninstall && (
        <ConfirmDialog
          title="Therascript vollständig entfernen"
          message="Alle Daten werden unwiderruflich gelöscht:"
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
