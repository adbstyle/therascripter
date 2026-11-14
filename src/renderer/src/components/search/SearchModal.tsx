import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Search } from 'lucide-react'
import { useSearch, isSemanticUnavailable, normalizeQueryInput } from '../../hooks/useSearch'
import { useNavigation } from '../../navigation/navigation'
import { semanticNotice } from '../../utils/searchNotice'
import { trapFocus } from '../../utils/focusTrap'
import { pluralize } from '../../utils/dossierFormat'
import { SearchResultsList } from './SearchResultsList'
import { SemanticNoticeBox } from './SemanticNoticeBox'
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
      search.update({ activeKey: option.key, interacted: true })
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
    if (event.key === 'Escape') {
      // Nur das Fenster schliessen, nicht den Editor oder ein Popover darunter
      event.preventDefault()
      event.stopPropagation()
      event.nativeEvent.stopImmediatePropagation()
      onClose()
      return
    }
    if (event.key === 'Tab') {
      trapFocus(event.nativeEvent, dialogRef.current)
      return
    }
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

  // Ansage der Trefferzahl (Live-Region)
  const announcement = !searched
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
        onKeyDown={onKeyDown}
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
          initialScrollTop={state.scrollTop}
          onScroll={(scrollTop) => search.update({ scrollTop, interacted: true })}
          onPointerActivity={() => {
            if (!state.interacted && !idle) search.update({ interacted: true })
          }}
          scrollable
          before={
            idle ? (
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
            ) : null
          }
        />

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2 text-[11px] text-text-tertiary">
          <span>Ausschnitte im Klartext · Treffer öffnen die Fundstelle</span>
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
