import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { RotateCw, Search } from 'lucide-react'
import { useSearch, isSemanticUnavailable, normalizeQueryInput } from '../../hooks/useSearch'
import { useNavigation } from '../../navigation/navigation'
import { semanticNotice } from '../../utils/searchNotice'
import { trapFocus } from '../../utils/focusTrap'
import { pluralize } from '../../utils/dossierFormat'
import { isReordered, updateSearchEntry } from '../../stores/searchSession'
import { useViewMode } from '../../viewMode/useViewMode'
import { SearchResultsList } from './SearchResultsList'
import { SemanticNoticeBox } from './SemanticNoticeBox'
import { ResultsHead } from './ResultsHead'
import {
  hitRouteFocus,
  moveActive,
  optionId,
  recentOptions,
  resultOptions,
  type SearchOption
} from './searchOptions'
import type { RecentSearchQuery } from '../../../../shared/types/Search'

const SCOPE_ALL = { kind: 'all' } as const

interface SearchModalProps {
  /** `navigate`: ein Treffer wurde geöffnet — der Fokus gehört dann der neuen Seite. */
  onClose: (reason?: 'navigate') => void
}

/**
 * Suchfenster über alle Inhalte (#209, Prototyp «Globale Suche als Modal»):
 * ⌘K bzw. «Suchen» in der Seitenleiste. Patientendossiers über Name oder ID
 * und Stellen in Sitzungen und PDF-Dokumenten; exakte Treffer sofort, Treffer
 * nach Bedeutung kommen nach. Leer: die fünf letzten Suchanfragen (AK 27/28).
 *
 * Tastatur: ↑/↓ durch alle Einträge (keine Vorauswahl), ↵ öffnet bzw. sucht,
 * Esc schliesst nur das Fenster, ⌘K schaltet um (Menü «Gehe zu»). Eine
 * geöffnete Sitzung bzw. ein geöffnetes Dossier führt mit ‹ / Esc hierher
 * zurück — dieselbe Anfrage, dieselben Treffer, dieselbe Stelle (AK 12).
 */
export function SearchModal({ onClose }: SearchModalProps): React.JSX.Element {
  const { navigate } = useNavigation()
  const search = useSearch(SCOPE_ALL)
  const { state } = search
  const [recent, setRecent] = useState<RecentSearchQuery[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const listId = `search-list-${useId().replace(/:/g, '')}`
  const plain = useViewMode() === 'plain'
  // Scroll-Position nur im Ref (kein Re-Render pro Scroll-Ereignis); in den
  // Store erst beim Schliessen bzw. Öffnen eines Treffers
  const scrollTopRef = useRef(state.scrollTop)
  const searchKey = search.key
  useEffect(() => {
    return () => {
      updateSearchEntry(searchKey, { scrollTop: scrollTopRef.current })
    }
  }, [searchKey])

  // Esc und Tab robust abfangen — auch wenn der Fokus auf body liegt (Klick auf
  // Text ohne Fokus) oder ausserhalb: Capture auf document, solange offen
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // Nur das Fenster schliessen, nicht den Editor oder ein Popover darunter
        event.preventDefault()
        event.stopPropagation()
        onCloseRef.current()
      } else if (event.key === 'Tab') {
        trapFocus(event, dialogRef.current)
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [])

  useEffect(() => {
    let alive = true
    window.api.search
      .recentList()
      .then((list) => {
        if (alive) setRecent(list)
      })
      .catch(() => {
        /* Ohne Liste bleibt «Letzte Suchen» leer */
      })
    return () => {
      alive = false
    }
  }, [])

  // Fokus ins Feld; der Text ist markiert, Tippen ersetzt die letzte Anfrage
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const idle = state.query.trim().length === 0 && state.submitted === null
  const options = useMemo<SearchOption[]>(
    () => (idle ? recentOptions(recent) : resultOptions(state.result, { includeDossiers: true })),
    [idle, recent, state.result]
  )
  const activeIndex =
    state.activeKey === null ? -1 : options.findIndex((o) => o.key === state.activeKey)

  const remember = useCallback(async (query: string | null) => {
    if (!query) return
    try {
      await window.api.search.recentRemember(query)
    } catch {
      /* Nicht kritisch: die Anfrage fehlt dann nur in «Letzte Suchen» */
    }
  }, [])

  const openOption = useCallback(
    (option: SearchOption) => {
      if (option.kind === 'recent') {
        search.searchNow(option.query)
        void remember(option.query)
        inputRef.current?.focus()
        return
      }
      search.update({ activeKey: option.key, interacted: true, scrollTop: scrollTopRef.current })
      void remember(state.submitted)
      onClose('navigate')
      if (option.kind === 'dossier') {
        navigate({ kind: 'dossier', dossierId: option.dossier.id }, { reopenOverlay: 'search' })
      } else if (option.kind === 'document') {
        navigate({ kind: 'session', sessionId: option.doc.sessionId }, { reopenOverlay: 'search' })
      } else {
        navigate(
          { kind: 'session', sessionId: option.doc.sessionId, focus: hitRouteFocus(option.hit) },
          { reopenOverlay: 'search' }
        )
      }
    },
    [navigate, onClose, remember, search, state.submitted]
  )

  const clearRecent = useCallback(async () => {
    try {
      await window.api.search.recentClear()
      setRecent([])
    } catch {
      /* Liste bleibt stehen — der USER sieht, dass nichts gelöscht wurde */
    }
    inputRef.current?.focus()
  }, [])

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.target !== inputRef.current) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      search.update({
        activeKey: moveActive(options, state.activeKey, event.key === 'ArrowDown' ? 1 : -1),
        interacted: true
      })
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const active = activeIndex >= 0 ? options[activeIndex] : null
      if (active) {
        openOption(active)
        return
      }
      search.searchNow()
      void remember(normalizeQueryInput(state.query))
    }
  }

  const notice = semanticNotice(search.availability, state.semantic)
  const result = state.result
  const dossierCount = result?.dossiers.length ?? 0
  const docCount = result?.results.length ?? 0
  const semanticPending = state.semantic === 'pending'
  const searched = state.submitted !== null && result !== null
  const noHits = searched && dossierCount === 0 && docCount === 0 && !semanticPending
  const failed = state.failed && state.submitted !== null
  const reordered = isReordered(state)

  // Ansage der Trefferzahl (Live-Region)
  const announcement = failed
    ? 'Die Suche ist fehlgeschlagen.'
    : !searched
      ? ''
      : noHits
        ? `Keine Treffer für «${state.submitted}»`
        : [
            dossierCount > 0
              ? pluralize(dossierCount, 'Patientendossier', 'Patientendossiers')
              : null,
            pluralize(docCount, 'Sitzung oder PDF-Dokument', 'Sitzungen und PDF-Dokumente'),
            semanticPending ? 'Treffer nach Bedeutung werden gesucht' : null
          ]
            .filter(Boolean)
            .join(', ')

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Patientendossiers und Inhalte durchsuchen"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onMouseDown={(e) => {
          // Klick auf Text ohne Fokus (Fusszeile, Überschriften, Hinweise): der
          // Fokus bleibt im Feld statt auf body zu fallen
          const target = e.target as HTMLElement
          if (!target.closest('input, button, a, [tabindex]:not([tabindex="-1"])')) {
            e.preventDefault()
            inputRef.current?.focus()
          }
        }}
        className="flex max-h-[72vh] w-full max-w-[680px] flex-col overflow-hidden rounded-xl border border-border bg-surface-0 shadow-xl"
      >
        <label className="flex items-center gap-2.5 border-b border-border px-4 py-3">
          <Search className="h-5 w-5 shrink-0 text-text-tertiary" strokeWidth={1.75} aria-hidden />
          <span className="sr-only">In allen Inhalten suchen</span>
          <input
            ref={inputRef}
            type="search"
            role="combobox"
            aria-expanded={options.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeIndex >= 0 ? optionId(listId, activeIndex) : undefined}
            value={state.query}
            maxLength={200}
            onChange={(e) => search.setQuery(e.target.value)}
            placeholder="Patientendossiers, Sitzungen und PDF-Dokumente durchsuchen"
            className="min-w-0 flex-1 bg-transparent text-[15px] text-text-primary outline-none placeholder:text-text-tertiary [&::-webkit-search-cancel-button]:hidden"
          />
          <kbd className="rounded border border-border px-1.5 py-0.5 font-sans text-[11px] text-text-tertiary">
            esc
          </kbd>
        </label>

        {notice && (
          <div className="px-4 pt-3">
            <SemanticNoticeBox
              notice={notice}
              onRetryModel={() => void search.retryModel()}
              onRetrySemantic={search.retrySemantic}
              canRetrySemantic={state.submitted !== null}
            />
          </div>
        )}

        <div role="status" aria-live="polite" className="sr-only">
          {announcement}
        </div>

        <SearchResultsList
          listId={listId}
          label={idle ? 'Letzte Suchen' : 'Treffer'}
          options={options}
          activeKey={state.activeKey}
          onSelect={openOption}
          showDocumentsHeading
          semanticPending={semanticPending && searched}
          truncated={!!result?.truncated && !idle}
          selectable={plain}
          initialScrollTop={state.scrollTop}
          onScrollPosition={(top) => {
            scrollTopRef.current = top
          }}
          onUserScroll={() => {
            if (!state.interacted && !idle) search.update({ interacted: true })
          }}
          scrollable
          before={
            failed ? (
              <div className="px-2.5 py-6 text-center" role="alert">
                <p className="text-sm font-semibold text-text-primary">
                  Die Suche ist fehlgeschlagen.
                </p>
                <p className="mt-1 text-sm text-text-secondary">
                  Die Anfrage «{state.submitted}» liess sich gerade nicht ausführen.
                </p>
                <button
                  type="button"
                  onClick={() => search.searchNow(state.submitted ?? state.query)}
                  className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-border-strong bg-surface-0 px-2.5 py-1 text-xs font-medium text-text-primary hover:bg-surface-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <RotateCw className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                  Erneut versuchen
                </button>
              </div>
            ) : idle ? (
              <IdleHeader hasRecent={recent.length > 0} onClear={() => void clearRecent()} />
            ) : noHits ? (
              <div className="px-2.5 py-6 text-center">
                <p className="text-sm font-semibold text-text-primary">
                  Keine Treffer für «{state.submitted}»
                </p>
                <p className="mt-1 text-sm text-text-secondary">
                  Kein Patientendossier, keine Sitzung und kein PDF-Dokument passt zu dieser
                  Anfrage.
                  {isSemanticUnavailable(state.semantic) &&
                    ' Die Suche nach Bedeutung hat dabei nicht mitgesucht.'}
                </p>
              </div>
            ) : searched ? (
              <ResultsHead
                plain={plain}
                reordered={reordered}
                onSortByRelevance={search.sortByRelevance}
              />
            ) : null
          }
        />

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2 text-[11px] text-text-tertiary">
          <span>Dossiers über Name oder ID · Ausschnitte im Klartext</span>
          <span>↑↓ wählen · ↵ öffnen · ⌘K und esc schliessen</span>
        </div>
      </div>
    </div>
  )
}

function IdleHeader({
  hasRecent,
  onClear
}: {
  hasRecent: boolean
  onClear: () => void
}): React.JSX.Element {
  if (!hasRecent) {
    return (
      <p className="px-2.5 py-4 text-sm leading-relaxed text-text-secondary">
        Findet Patientendossiers über Name oder Dossier-ID und Stellen in Sitzungen und
        PDF-Dokumenten nach ihrer Bedeutung, nach genauen Begriffen und nach Klarnamen.
      </p>
    )
  }
  return (
    <div className="flex items-center justify-between px-2.5 pb-1 pt-3">
      <span className="text-xs font-semibold text-text-tertiary">Letzte Suchen</span>
      <button
        type="button"
        onClick={onClear}
        className="rounded px-1.5 py-0.5 text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        Verlauf löschen
      </button>
    </div>
  )
}
