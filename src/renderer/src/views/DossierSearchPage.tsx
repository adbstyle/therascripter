import { useCallback, useEffect, useId, useMemo, useRef } from 'react'
import type { KeyboardEvent } from 'react'
import { RotateCw, Search } from 'lucide-react'
import { useNavigation } from '../navigation/navigation'
import { useScrollRestoration } from '../navigation/useScrollRestoration'
import { useLiveQuery } from '../hooks/useLiveQuery'
import { isSemanticUnavailable, useSearch } from '../hooks/useSearch'
import { semanticNotice } from '../utils/searchNotice'
import { dossierListName, pluralize } from '../utils/dossierFormat'
import { SearchResultsList } from '../components/search/SearchResultsList'
import { SemanticNoticeBox } from '../components/search/SemanticNoticeBox'
import { ResultsHead } from '../components/search/ResultsHead'
import { isReordered } from '../stores/searchSession'
import { useViewMode } from '../viewMode/useViewMode'
import {
  hitRouteFocus,
  moveActive,
  optionId,
  resultOptions,
  type SearchOption
} from '../components/search/searchOptions'
import type { Dossier } from '../../../shared/types/Dossier'

interface DossierSearchPageProps {
  dossierId: string
}

/**
 * Suche in einem Patientendossier (#211, Prototyp «Suche mit Treffern»):
 * eine eigene Seite, aus dem Dossier über «Im Dossier suchen» erreicht. Sie
 * sucht nur in den Sitzungen und PDF-Dokumenten, die dem Dossier zum
 * Zeitpunkt der Suche zugeordnet sind (AK 1, Filter im Main-Prozess nach dem
 * Ranking: dieselbe Reihenfolge wie über alle Inhalte, AK 3). Der Kopf nennt
 * den Bereich bei jeder Suche (AK 2); umschalten lässt er sich nicht (OOS 2).
 * Keine Dossier-Treffer; Anfragen kommen nicht unter «Letzte Suchen» (OOS 3).
 * Anfrage und Treffer bleiben pro Dossier bis zur nächsten Suche, zum
 * Löschen des Dossiers oder zum Neustart (AK 4).
 */
export default function DossierSearchPage({
  dossierId
}: DossierSearchPageProps): React.JSX.Element {
  const { navigate } = useNavigation()
  const scope = useMemo(() => ({ kind: 'dossier' as const, dossierId }), [dossierId])
  const search = useSearch(scope)
  const { state } = search
  const dossier = useLiveQuery<Dossier | null>(
    () => window.api.dossiers.get(dossierId),
    [(cb) => window.api.dossiers.onChanged(() => cb())],
    null
  )
  const inputRef = useRef<HTMLInputElement>(null)
  const plain = useViewMode() === 'plain'
  const listId = `dossier-search-${useId().replace(/:/g, '')}`
  useScrollRestoration(true)

  useEffect(() => {
    // Ohne gemerkte Anfrage gleich ins Feld; beim Zurückkehren bleibt die Stelle
    if (state.submitted === null) inputRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const options = useMemo(
    () => resultOptions(state.result, { includeDossiers: false }),
    [state.result]
  )
  const activeIndex =
    state.activeKey === null ? -1 : options.findIndex((o) => o.key === state.activeKey)

  const openOption = useCallback(
    (option: SearchOption) => {
      search.update({ activeKey: option.key, interacted: true })
      if (option.kind === 'document') {
        navigate({ kind: 'session', sessionId: option.doc.sessionId }, { anchorId: option.key })
      } else if (option.kind === 'hit') {
        navigate(
          { kind: 'session', sessionId: option.doc.sessionId, focus: hitRouteFocus(option.hit) },
          { anchorId: option.key }
        )
      }
    },
    [navigate, search]
  )

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      search.update({
        activeKey: moveActive(options, state.activeKey, event.key === 'ArrowDown' ? 1 : -1),
        interacted: true
      })
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const active = activeIndex >= 0 ? options[activeIndex] : null
      if (active) openOption(active)
      else search.searchNow()
    } else if (event.key === 'Escape' && state.activeKey !== null) {
      event.preventDefault()
      search.update({ activeKey: null })
    }
  }

  const name = dossier.data ? dossierListName(dossier.data) : null
  const result = state.result
  const docCount = result?.results.length ?? 0
  const searched = state.submitted !== null && result !== null
  const semanticPending = state.semantic === 'pending'
  const noHits = searched && docCount === 0 && !semanticPending
  const notice = semanticNotice(search.availability, state.semantic)

  const announcement = !searched
    ? ''
    : noHits
      ? `Keine Treffer für «${state.submitted}»`
      : `${pluralize(docCount, 'Dokument', 'Dokumente')}${semanticPending ? ', Treffer nach Bedeutung werden gesucht' : ''}`

  return (
    <div className="mx-auto flex w-full max-w-[860px] flex-col gap-4 px-6 pb-6 pt-5">
      <div className="flex flex-col gap-2">
        <label className="flex items-center gap-2.5 rounded-lg border border-border-strong bg-surface-0 px-3 py-2 focus-within:ring-2 focus-within:ring-primary">
          <Search className="h-5 w-5 shrink-0 text-text-tertiary" strokeWidth={1.75} aria-hidden />
          <span className="sr-only">
            {name ? `Suchanfrage im Patientendossier ${name}` : 'Suchanfrage im Patientendossier'}
          </span>
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
            onKeyDown={onKeyDown}
            placeholder="Wonach suchen Sie? Ein Thema, ein Begriff oder ein Name"
            className="min-w-0 flex-1 bg-transparent text-[15px] text-text-primary outline-none placeholder:text-text-tertiary"
          />
        </label>
        {/* Bereich bei jeder Suche erkennbar (AK 2) */}
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-secondary">
          <span>Suche im Patientendossier</span>
          <button
            type="button"
            onClick={() => navigate({ kind: 'dossier', dossierId })}
            className="rounded-full bg-primary-light px-2 py-0.5 font-medium text-text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            {name ?? '…'}
          </button>
          {searched && docCount > 0 && (
            <span>{pluralize(docCount, 'Dokument', 'Dokumente')} · Ausschnitte im Klartext</span>
          )}
          {(!searched || docCount === 0) && <span>Ausschnitte im Klartext</span>}
        </p>
      </div>

      {notice && (
        <SemanticNoticeBox
          notice={notice}
          onRetryModel={() => void search.retryModel()}
          onRetrySemantic={search.retrySemantic}
          canRetrySemantic={state.submitted !== null}
        />
      )}

      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>

      {!searched && !state.failed && (
        <p className="text-sm leading-relaxed text-text-secondary">
          Die Suche findet Stellen nach ihrer Bedeutung, nach genauen Begriffen und nach den
          Klarnamen erwähnter Personen — nur in den Sitzungen und PDF-Dokumenten dieses
          Patientendossiers.
        </p>
      )}

      {state.failed && state.submitted !== null && (
        <div role="alert" className="rounded-lg border border-border px-4 py-5">
          <p className="text-sm font-semibold text-text-primary">Die Suche ist fehlgeschlagen.</p>
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
      )}

      {noHits && (
        <div className="rounded-lg border border-border px-4 py-5">
          <p className="text-sm font-semibold text-text-primary">
            Keine Treffer für «{state.submitted}»
          </p>
          <p className="mt-1 text-sm text-text-secondary">
            Im Patientendossier {name ?? ''} passt keine Stelle zu dieser Anfrage. Für alle Inhalte
            suchen Sie mit ⌘K.
            {isSemanticUnavailable(state.semantic) &&
              ' Die Suche nach Bedeutung hat dabei nicht mitgesucht.'}
          </p>
        </div>
      )}

      <SearchResultsList
        listId={listId}
        label={name ? `Treffer im Patientendossier ${name}` : 'Treffer im Patientendossier'}
        options={options}
        activeKey={state.activeKey}
        onSelect={openOption}
        showDocumentsHeading={false}
        semanticPending={semanticPending && searched}
        truncated={!!result?.truncated}
        selectable={plain}
        onUserScroll={() => {
          if (!state.interacted && searched) search.update({ interacted: true })
        }}
        scrollable={false}
        before={
          searched && docCount > 0 ? (
            <ResultsHead
              plain={plain}
              reordered={isReordered(state)}
              onSortByRelevance={search.sortByRelevance}
            />
          ) : null
        }
      />
    </div>
  )
}
