import { useCallback, useEffect, useState } from 'react'
import type { AboutInfo } from '../../../shared/types'
import { ConfirmDialog } from './ConfirmDialog'
import { formatBytes } from '../utils/formatBytes'
import { useAppUpdate } from '../hooks/useAppUpdate'
import AppLogo from './AppLogo'

const ACKNOWLEDGMENTS = [
  {
    name: 'Whisper.cpp',
    description: 'Automatische Spracherkennung (ASR) — wandelt Audiodaten in Text um'
  },
  {
    name: 'pyannote.audio',
    description: 'Sprecherdiarisierung — erkennt und trennt verschiedene Gesprächspersonen'
  },
  {
    name: 'flair',
    description:
      'Named Entity Recognition (NER) — identifiziert Personen, Orte und andere Entitäten'
  },
  {
    name: 'TipTap',
    description: 'Review-Editor — ermöglicht die Bearbeitung des anonymisierten Textes'
  },
  {
    name: 'Electron',
    description: 'Desktop-App-Framework — ermöglicht die native macOS-Anwendung'
  },
  {
    name: 'pdfjs-dist',
    description: 'PDF-Textextraktion — liest Text aus importierten PDF-Dokumenten aus'
  },
  {
    name: 'better-sqlite3',
    description: 'Lokale Datenbank — speichert Sitzungen und Sperrliste auf dem Gerät'
  }
]

export default function AboutPage(): React.JSX.Element {
  const [info, setInfo] = useState<AboutInfo | null>(null)
  const [showUninstall, setShowUninstall] = useState(false)
  const { status: appUpdateStatus, checking, checkNow, openReleasePage } = useAppUpdate()

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
            Therascript v{info?.version ?? '\u2026'}
          </h3>
          <p className="text-sm text-text-tertiary">Open Source (MIT-Lizenz)</p>
        </div>

        {/* App Update */}
        <div>
          <div className="flex items-center gap-3">
            <button
              className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-2 disabled:opacity-50"
              onClick={checkNow}
              disabled={checking}
            >
              {checking ? 'Pr\u00FCfe\u2026' : 'Nach Updates suchen'}
            </button>
            {appUpdateStatus?.available && (
              <button
                className="text-sm font-medium text-primary transition-colors hover:text-primary-hover"
                onClick={openReleasePage}
              >
                Neue Version verf\u00FCgbar &mdash; herunterladen
              </button>
            )}
            {appUpdateStatus && !appUpdateStatus.available && appUpdateStatus.checkedAt && (
              <span className="text-sm text-text-tertiary">Therascript ist aktuell</span>
            )}
          </div>
        </div>

        <p className="text-sm text-text-secondary">
          Alle Verarbeitung findet komplett lokal auf Ihrem Mac statt.
        </p>

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
              {info?.dataDir ?? '\u2026'}
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

        {/* Daten info box */}
        <div className="rounded-lg border border-border bg-surface-1 p-4">
          <h4 className="mb-1 text-sm font-medium text-text-secondary">Daten</h4>
          <p className="text-sm text-text-secondary">
            Sitzungen werden automatisch 30 Tage nach Erstellung gel\u00F6scht.
          </p>
          <p className="mt-1 text-sm text-text-secondary">
            Sie sind verantwortlich, den kopierten Text extern zu sichern.
          </p>
        </div>

        {/* Acknowledgments */}
        <div>
          <h4 className="mb-2 text-sm font-medium text-text-secondary">Acknowledgments</h4>
          <div className="space-y-2">
            {ACKNOWLEDGMENTS.map((item) => (
              <div key={item.name}>
                <span className="text-sm font-medium text-text-secondary">{item.name}</span>
                <span className="text-sm text-text-tertiary"> — {item.description}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Uninstall button */}
        <button
          className="rounded-lg border border-error-border px-4 py-2 text-sm font-medium text-error-text transition-colors hover:bg-error-bg"
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
