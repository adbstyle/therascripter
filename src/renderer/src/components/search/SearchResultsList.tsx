import { Fragment, memo, useCallback, useEffect, useMemo, useRef } from 'react'
import type { UIEvent } from 'react'
import { BookUser, FileText, History, Loader2, Mic } from 'lucide-react'
import type { SearchSnippet } from '../../../../shared/types/Search'
import { formatSwissDate } from '../../../../shared/utils/calendar-date'
import { sessionTitleIn } from '../../viewMode/sessionText'
import { useViewMode } from '../../viewMode/useViewMode'
import {
  dossierIdentification,
  dossierLabel,
  dossierListName,
  entryCountLabel,
  pluralize
} from '../../utils/dossierFormat'
import { useAmbiguousDossierNames } from '../../stores/dossierNames'
import type { ViewMode } from '../../../../shared/types/ViewMode'
import {
  hitLabel,
  optionId,
  searchRowRenders,
  UNTITLED_DOCUMENT,
  type SearchOption
} from './searchOptions'

interface SearchResultsListProps {
  listId: string
  /** Name der Liste für Screenreader. */
  label: string
  options: SearchOption[]
  activeKey: string | null
  onSelect: (option: SearchOption) => void
  /** Kopfzeile über den Inhalten anzeigen («Sitzungen und PDF-Dokumente · 3 Treffer»). */
  showDocumentsHeading: boolean
  /** Treffer nach Bedeutung werden noch gesucht (Ladeanzeige nur für diesen Teil). */
  semanticPending: boolean
  /** Mehr Sitzungen getroffen, als die Antwort enthält. */
  truncated: boolean
  /**
   * false (pseudonymisierte Ansicht): Klartext-Ausschnitte lassen sich weder
   * auswählen noch kopieren — kopiert wird immer die gewählte Ansicht (#203).
   */
  selectable: boolean
  /** Zuletzt gemerkte Scroll-Position; wird beim Einhängen wiederhergestellt. */
  initialScrollTop?: number
  /** Jede Scroll-Position (für einen Ref — kein Re-Render). */
  onScrollPosition?: (scrollTop: number) => void
  /** Der USER scrollt selbst (Rad, Wischen, Scrollleiste) — nicht programmatisch. */
  onUserScroll?: () => void
  /** Eigener Scroll-Container (Modal); sonst scrollt die Seite. */
  scrollable: boolean
  /** Inhalt vor den Einträgen innerhalb des Scroll-Bereichs (z. B. «Letzte Suchen»-Kopf). */
  before?: React.ReactNode
  after?: React.ReactNode
}

/**
 * Trefferliste der Suche (#209 AK 7–9, AK 24/25) als `listbox`: Dossiers
 * getrennt und vorn mit «ID · Geburtsdatum», dann je Sitzung bzw.
 * PDF-Dokument eine Gruppe mit Kopf (Titel in der gewählten Ansicht, Datum,
 * zugeordnete Dossiers) und bis zu drei Fundstellen. Ausschnitte stehen immer
 * im Klartext; exakte Stellen sind markiert, Treffer nach Bedeutung gepunktet.
 *
 * Der Fokus bleibt im Eingabefeld (Combobox mit `aria-activedescendant`);
 * Klicks verschieben ihn deshalb nicht. Zeilen und Gruppen sind memoisiert:
 * Tippen, Scrollen und Pfeiltasten rendern nur, was sich ändert.
 */
export function SearchResultsList({
  listId,
  label,
  options,
  activeKey,
  onSelect,
  showDocumentsHeading,
  semanticPending,
  truncated,
  selectable,
  initialScrollTop = 0,
  onScrollPosition,
  onUserScroll,
  scrollable,
  before,
  after
}: SearchResultsListProps): React.JSX.Element {
  const viewMode = useViewMode()
  const listRef = useRef<HTMLDivElement>(null)
  const scrollRestored = useRef(false)
  // Stabile Auswahl-Funktion für die memoisierten Zeilen
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  const select = useCallback((option: SearchOption) => onSelectRef.current(option), [])

  // Rücksprung: dieselbe Stelle der Liste (#209 AK 12)
  useEffect(() => {
    if (scrollRestored.current || !scrollable) return
    scrollRestored.current = true
    if (listRef.current && initialScrollTop > 0) listRef.current.scrollTop = initialScrollTop
  }, [initialScrollTop, scrollable])

  // Ausgewählten Eintrag sichtbar halten (Pfeiltasten)
  useEffect(() => {
    if (activeKey === null) return
    const index = options.findIndex((o) => o.key === activeKey)
    if (index < 0) return
    const el = document.getElementById(optionId(listId, index))
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' })
  }, [activeKey, options, listId])

  const layout = useMemo(() => buildLayout(options), [options])

  return (
    <div
      ref={listRef}
      onScroll={(e: UIEvent<HTMLDivElement>) => onScrollPosition?.(e.currentTarget.scrollTop)}
      onWheel={onUserScroll}
      onTouchMove={onUserScroll}
      onPointerDown={(e) => {
        // Klick auf die Scrollleiste selbst
        if (e.target === e.currentTarget) onUserScroll?.()
      }}
      data-testid="search-results"
      className={`${scrollable ? 'min-h-0 flex-1 overflow-y-auto px-2 pb-2' : ''} ${
        selectable ? '' : 'select-none'
      }`}
    >
      {before}
      <div id={listId} role="listbox" aria-label={label} className="flex flex-col gap-0.5">
        {layout.recent.map(({ option, index }) => (
          <OptionRow
            key={option.key}
            option={option}
            id={optionId(listId, index)}
            active={option.key === activeKey}
            onSelect={select}
            viewMode={viewMode}
          />
        ))}

        {layout.dossiers.length > 0 && (
          <div role="group" aria-labelledby={`${listId}-dossiers`} className="flex flex-col">
            <p
              id={`${listId}-dossiers`}
              className="px-2.5 pb-1 pt-2 text-xs font-semibold text-text-tertiary"
            >
              Patientendossiers
            </p>
            {layout.dossiers.map(({ option, index }) => (
              <OptionRow
                key={option.key}
                option={option}
                id={optionId(listId, index)}
                active={option.key === activeKey}
                onSelect={select}
                viewMode={viewMode}
              />
            ))}
          </div>
        )}

        {showDocumentsHeading && layout.documents.length > 0 && (
          <p
            role="presentation"
            className="px-2.5 pb-1 pt-3 text-xs font-semibold text-text-tertiary"
          >
            Sitzungen und PDF-Dokumente · {pluralize(layout.documents.length, 'Treffer', 'Treffer')}
          </p>
        )}

        {layout.documents.map((group) => (
          <DocumentGroup
            key={group.header.option.key}
            group={group}
            listId={listId}
            activeKey={group.keys.has(activeKey ?? '') ? activeKey : null}
            onSelect={select}
            viewMode={viewMode}
          />
        ))}
      </div>

      {semanticPending && (
        <p
          className="flex items-center gap-2 px-2.5 py-2 text-xs text-text-secondary"
          data-testid="semantic-pending"
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} aria-hidden />
          Treffer nach Bedeutung werden gesucht …
        </p>
      )}
      {truncated && (
        <p className="px-2.5 py-2 text-xs text-text-secondary">
          Es gibt weitere Treffer. Angezeigt werden die passendsten — verfeinern Sie die Anfrage, um
          die übrigen zu finden.
        </p>
      )}
      {after}
    </div>
  )
}

interface Placed {
  option: SearchOption
  index: number
}

interface DocumentLayout {
  header: Placed
  hits: Placed[]
  keys: Set<string>
}

function buildLayout(options: SearchOption[]): {
  recent: Placed[]
  dossiers: Placed[]
  documents: DocumentLayout[]
} {
  const recent: Placed[] = []
  const dossiers: Placed[] = []
  const documents: DocumentLayout[] = []
  options.forEach((option, index) => {
    if (option.kind === 'recent') recent.push({ option, index })
    else if (option.kind === 'dossier') dossiers.push({ option, index })
    else if (option.kind === 'document') {
      documents.push({ header: { option, index }, hits: [], keys: new Set([option.key]) })
    } else {
      const group = documents[documents.length - 1]
      if (group) {
        group.hits.push({ option, index })
        group.keys.add(option.key)
      }
    }
  })
  return { recent, dossiers, documents }
}

const DocumentGroup = memo(function DocumentGroup({
  group,
  listId,
  activeKey,
  onSelect,
  viewMode
}: {
  group: DocumentLayout
  listId: string
  activeKey: string | null
  onSelect: (option: SearchOption) => void
  viewMode: ViewMode
}): React.JSX.Element {
  const headerId = `${optionId(listId, group.header.index)}-title`
  return (
    <div
      role="group"
      aria-labelledby={headerId}
      className="flex flex-col border-t border-border pt-1 first:border-t-0"
    >
      {[group.header, ...group.hits].map(({ option, index }) => (
        <OptionRow
          key={option.key}
          option={option}
          id={optionId(listId, index)}
          titleId={option === group.header.option ? headerId : undefined}
          active={option.key === activeKey}
          onSelect={onSelect}
          viewMode={viewMode}
        />
      ))}
    </div>
  )
})

const OptionRow = memo(function OptionRow({
  option,
  id,
  titleId,
  active,
  onSelect,
  viewMode
}: {
  option: SearchOption
  id: string
  titleId?: string
  active: boolean
  onSelect: (option: SearchOption) => void
  viewMode: ViewMode
}): React.JSX.Element {
  searchRowRenders.count++
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      data-anchor-id={option.key}
      // Fokus bleibt im Eingabefeld
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onSelect(option)}
      className={`cursor-pointer rounded-md transition-colors ${
        active ? 'bg-surface-2 ring-1 ring-primary' : 'hover:bg-surface-2'
      }`}
    >
      <OptionContent option={option} titleId={titleId} viewMode={viewMode} />
    </div>
  )
})

function OptionContent({
  option,
  titleId,
  viewMode
}: {
  option: SearchOption
  titleId?: string
  viewMode: ViewMode
}): React.JSX.Element {
  const ambiguous = useAmbiguousDossierNames()
  switch (option.kind) {
    case 'recent':
      return (
        <div className="flex items-center gap-2.5 px-2.5 py-2 text-sm text-text-primary">
          <History className="h-4 w-4 shrink-0 text-text-tertiary" strokeWidth={1.75} aria-hidden />
          <span className="truncate">{option.query}</span>
        </div>
      )
    case 'dossier': {
      const identification = dossierIdentification(option.dossier)
      return (
        <div className="flex items-center gap-2.5 px-2.5 py-2 text-sm">
          <BookUser
            className="h-4 w-4 shrink-0 text-text-tertiary"
            strokeWidth={1.75}
            aria-hidden
          />
          <span className="truncate font-medium text-text-primary">
            {dossierListName(option.dossier)}
          </span>
          {identification && (
            <span className="truncate text-xs text-text-secondary">{identification}</span>
          )}
          {option.dossier.entryCount !== undefined && (
            <span className="ml-auto shrink-0 text-xs text-text-tertiary">
              {entryCountLabel(option.dossier.entryCount)}
            </span>
          )}
        </div>
      )
    }
    case 'document': {
      const doc = option.doc
      const title = sessionTitleIn(doc, viewMode).trim() || UNTITLED_DOCUMENT
      return (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2.5 py-1.5 text-sm">
          {doc.type === 'audio' ? (
            <Mic
              className="h-4 w-4 shrink-0 text-text-tertiary"
              strokeWidth={1.75}
              aria-label="Sitzung"
            />
          ) : (
            <FileText
              className="h-4 w-4 shrink-0 text-text-tertiary"
              strokeWidth={1.75}
              aria-label="PDF-Dokument"
            />
          )}
          <span id={titleId} className="min-w-0 truncate font-semibold text-text-primary">
            {title}
          </span>
          <span className="text-xs text-text-secondary">{formatSwissDate(doc.sortDay)}</span>
          {doc.dossiers.map((d) => (
            <span
              key={d.id}
              className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-text-secondary"
            >
              {dossierLabel(d, ambiguous)}
            </span>
          ))}
        </div>
      )
    }
    case 'hit':
      return (
        <div className="flex gap-3 px-2.5 py-1.5 pl-8 text-sm">
          <span className="w-28 shrink-0 hyphens-auto break-words text-xs leading-5 text-text-tertiary">
            {hitLabel(option.hit, option.doc.type)}
          </span>
          <SnippetText snippet={option.hit.snippet} semantic={option.hit.kind === 'semantic'} />
        </div>
      )
  }
}

/** Ausschnitt im Klartext; exakte Stellen markiert, Treffer nach Bedeutung gepunktet. */
function SnippetText({
  snippet,
  semantic
}: {
  snippet: SearchSnippet
  semantic: boolean
}): React.JSX.Element {
  const parts: React.ReactNode[] = []
  let at = 0
  const marks = [...snippet.marks]
    .filter((m) => m.start >= 0 && m.end > m.start && m.end <= snippet.text.length)
    .sort((a, b) => a.start - b.start)
  for (const mark of marks) {
    if (mark.start < at) continue
    if (mark.start > at) parts.push(snippet.text.slice(at, mark.start))
    parts.push(
      <mark key={mark.start} className="rounded-sm bg-primary-light px-0.5 text-inherit">
        {snippet.text.slice(mark.start, mark.end)}
      </mark>
    )
    at = mark.end
  }
  if (at < snippet.text.length) parts.push(snippet.text.slice(at))
  return (
    <span
      className={`min-w-0 flex-1 leading-5 text-text-primary ${
        semantic ? 'underline decoration-primary decoration-dotted underline-offset-[3px]' : ''
      }`}
    >
      {snippet.truncatedStart && '… '}
      {parts.map((p, i) => (
        <Fragment key={i}>{p}</Fragment>
      ))}
      {snippet.truncatedEnd && ' …'}
    </span>
  )
}
