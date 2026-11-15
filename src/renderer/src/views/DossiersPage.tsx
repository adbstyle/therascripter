import { useCallback, useDeferredValue, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { BookUser, Plus, Search } from 'lucide-react'
import { PageContainer } from '../components/shell/PageHeader'
import { DossierListRow } from '../components/dossier/DossierListRow'
import { useNavigation } from '../navigation/navigation'
import { useScrollRestoration } from '../navigation/useScrollRestoration'
import { useWorkspaceActions } from '../contexts/workspaceActions'
import { useLiveQuery } from '../hooks/useLiveQuery'
import { useStartOfToday } from '../hooks/useStartOfToday'
import { filterDossiers, prepareDossierFilter } from '../utils/dossierFilter'
import { localTodayIso } from '../../../shared/utils/calendar-date'
import type { DossierListItem } from '../../../shared/types/Dossier'

const EMPTY: DossierListItem[] = []

/**
 * Übersicht «Alle Patientendossiers» (#204 AK 12–15): eine durchgehende Liste,
 * alphabetisch nach Nachnamen (sortiert liefert sie der Main-Prozess), mit
 * Filter nach Vor- und Nachnamen. Lädt bei `dossiers:changed` und
 * `sessions:changed` nach (Namen, Anzahl und letzter Eintrag ändern sich).
 */
export default function DossiersPage(): React.JSX.Element {
  const { navigate } = useNavigation()
  const { openNewDossier } = useWorkspaceActions()
  const { data: dossiers, loading } = useLiveQuery(
    () => window.api.dossiers.list(),
    [
      (cb) => window.api.dossiers.onChanged(() => cb()),
      (cb) => window.api.sessions.onChanged(() => cb())
    ],
    EMPTY
  )
  const [query, setQuery] = useState('')
  // Tippen bleibt flüssig, auch wenn das Filtern von 500 Zeilen einen Moment braucht (AK 15)
  const deferredQuery = useDeferredValue(query)
  const prepared = useMemo(() => prepareDossierFilter(dossiers), [dossiers])
  const visible = useMemo(() => filterDossiers(prepared, deferredQuery), [prepared, deferredQuery])
  const startOfToday = useStartOfToday()
  const todayIso = useMemo(() => localTodayIso(new Date(startOfToday)), [startOfToday])
  const listRef = useRef<HTMLUListElement>(null)
  const filterRef = useRef<HTMLInputElement>(null)

  useScrollRestoration(!loading)

  // Die Herkunftszeile merkt sich der Verlaufseintrag dieser Seite (‹ hebt sie hervor)
  const openDossier = useCallback(
    (dossierId: string) => navigate({ kind: 'dossier', dossierId }, { anchorId: dossierId }),
    [navigate]
  )

  // Pfeiltasten bewegen den Fokus durch die Zeilen; vom Filter aus ↓ in die erste Zeile
  const moveFocus = useCallback((from: HTMLElement | null, delta: 1 | -1) => {
    const rows = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('[data-dossier-row]') ?? []
    )
    if (rows.length === 0) return
    const index = from ? rows.indexOf(from as HTMLButtonElement) : -1
    const next = index + delta
    if (next < 0) filterRef.current?.focus()
    else rows[Math.min(next, rows.length - 1)].focus()
  }, [])

  const onRowKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        moveFocus(event.currentTarget, event.key === 'ArrowDown' ? 1 : -1)
      }
    },
    [moveFocus]
  )

  const hasDossiers = dossiers.length > 0

  return (
    <PageContainer>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h1 className="text-xl font-semibold leading-7 text-text-primary">Patientendossiers</h1>
          {hasDossiers && (
            <span className="text-xs text-text-secondary">
              {dossiers.length}
              <span className="sr-only"> insgesamt</span>
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={openNewDossier}
          className="flex items-center gap-1.5 rounded-lg bg-primary-solid px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-solid-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
        >
          <Plus className="h-4 w-4" strokeWidth={2} aria-hidden />
          Neues Patientendossier
        </button>
      </header>

      {!loading && !hasDossiers && <EmptyOverview onCreate={openNewDossier} />}

      {hasDossiers && (
        <>
          <label className="flex items-center gap-2 rounded-lg border border-border-strong bg-surface-0 px-3 py-2 focus-within:ring-2 focus-within:ring-primary">
            <Search
              className="h-4 w-4 shrink-0 text-text-secondary"
              strokeWidth={1.75}
              aria-hidden
            />
            <span className="sr-only">Nach Namen filtern</span>
            <input
              ref={filterRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  moveFocus(null, 1)
                }
              }}
              placeholder="Nach Vor- oder Nachnamen filtern"
              autoComplete="off"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none"
            />
          </label>

          {visible.length === 0 ? (
            <p role="status" className="px-2 py-6 text-sm text-text-secondary">
              Kein Patientendossier passt zu «{deferredQuery.trim()}».
            </p>
          ) : (
            <ul ref={listRef} aria-label="Patientendossiers" className="flex flex-col">
              {visible.map((dossier) => (
                <DossierListRow
                  key={dossier.id}
                  dossier={dossier}
                  todayIso={todayIso}
                  onOpen={openDossier}
                  onKeyDown={onRowKeyDown}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </PageContainer>
  )
}

/** Leere Übersicht mit Anleitung (#204 AK 13). */
function EmptyOverview({ onCreate }: { onCreate: () => void }): React.JSX.Element {
  return (
    <div className="flex max-w-[340px] flex-col items-start gap-2.5 rounded-xl border border-dashed border-border-strong p-6">
      <BookUser className="h-7 w-7 text-text-secondary" strokeWidth={1.5} aria-hidden />
      <h2 className="text-base font-semibold leading-6 text-text-primary">
        Noch keine Patientendossiers
      </h2>
      <p className="text-[13px] leading-[19px] text-text-secondary">
        Ein Patientendossier bündelt alle Sitzungen und PDF-Dokumente einer Person. Legen Sie es mit
        Vor- und Nachnamen an; weitere Angaben sind freiwillig.
      </p>
      <button
        type="button"
        onClick={onCreate}
        className="rounded-lg bg-primary-solid px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-solid-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
      >
        Neues Patientendossier
      </button>
    </div>
  )
}
