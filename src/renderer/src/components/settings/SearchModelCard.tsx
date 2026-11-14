import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2, Clock, Loader2, RotateCw } from 'lucide-react'
import type { SearchModelState } from '../../../../shared/types/Search'
import {
  describeSearchModel as describe,
  searchModelStatusLabel as statusLabel
} from '../../utils/searchModelStatus'

/**
 * Statuskarte «Suchmodell» in Einstellungen → Modelle (Epic #192, #210 AK 4/5).
 * Reine Anzeige: das Suchmodell wird weder aktiviert noch gelöscht; fehlt es,
 * lädt es die App selbst im Hintergrund nach. Nur bei einem Fehlschlag gibt
 * es «Erneut versuchen».
 */
export default function SearchModelCard(): React.JSX.Element {
  const [state, setState] = useState<SearchModelState | null>(null)
  const [retrying, setRetrying] = useState(false)
  /** Rückmeldung, wenn «Erneut versuchen» wegen laufender Arbeit nicht sofort lädt. */
  const [deferredRetry, setDeferredRetry] = useState(false)

  useEffect(() => {
    let active = true
    window.api.search
      .open()
      .then((a) => {
        if (active) setState(a.model)
      })
      .catch(() => {
        /* Karte bleibt leer — die übrigen Einstellungen funktionieren weiter */
      })
    const unsubscribe = window.api.search.onAvailabilityChanged((a) => {
      setState(a.model)
      if (a.model.status !== 'waiting') setDeferredRetry(false)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  const retry = useCallback(async () => {
    setRetrying(true)
    try {
      const next = await window.api.search.retryModel()
      setState(next.model)
      setDeferredRetry(next.model.status === 'waiting' && next.model.reason === 'busy')
    } catch {
      /* Der Zustand kommt über onAvailabilityChanged */
    } finally {
      setRetrying(false)
    }
  }, [])

  const canRetry = state?.status === 'failed' || state?.status === 'retry-scheduled'

  return (
    <div
      className="rounded-lg border border-border p-4"
      role="group"
      aria-labelledby="search-model-name"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 id="search-model-name" className="font-semibold text-text-primary">
              Suchmodell
            </h3>
            {state && <StatusIcon state={state} />}
            {/* Angesagt wird nur der Zustandswechsel, nicht jedes Prozent */}
            <span role="status" aria-live="polite" className="text-sm text-text-secondary">
              {state ? statusLabel(state) : ''}
            </span>
          </div>
          <p className="mt-2 text-sm leading-relaxed text-text-secondary">
            {state ? describe(state) : 'Zustand wird abgefragt…'}
          </p>

          {state?.status === 'downloading' && (
            <div className="mt-3 space-y-1">
              <div
                className="h-2 overflow-hidden rounded-full bg-surface-2"
                role="progressbar"
                aria-valuenow={state.progress}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Fortschritt beim Laden des Suchmodells"
              >
                <div
                  className="h-full rounded-full bg-primary transition-all duration-300"
                  style={{ width: `${state.progress}%` }}
                />
              </div>
              <p className="text-xs text-text-tertiary">{state.progress} %</p>
            </div>
          )}

          {deferredRetry && (
            <p className="mt-3 text-sm text-text-secondary">
              Gerade läuft eine Aufnahme oder Verarbeitung. Das Suchmodell wird geladen, sobald sie
              abgeschlossen ist.
            </p>
          )}

          {canRetry && (
            <button
              type="button"
              onClick={retry}
              disabled={retrying}
              className="titlebar-no-drag mt-3 inline-flex items-center gap-2 rounded-lg bg-primary-solid px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-solid-hover disabled:opacity-50"
            >
              <RotateCw className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
              Erneut versuchen
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function StatusIcon({ state }: { state: SearchModelState }): React.JSX.Element | null {
  switch (state.status) {
    case 'ready':
      return <CheckCircle2 className="h-4 w-4 text-success" strokeWidth={2} aria-hidden="true" />
    case 'downloading':
      return (
        <Loader2 className="h-4 w-4 animate-spin text-primary" strokeWidth={2} aria-hidden="true" />
      )
    case 'waiting':
    case 'retry-scheduled':
      return <Clock className="h-4 w-4 text-text-tertiary" strokeWidth={2} aria-hidden="true" />
    case 'failed':
      return <AlertCircle className="h-4 w-4 text-error-text" strokeWidth={2} aria-hidden="true" />
    case 'unpublished':
      return null
  }
}
