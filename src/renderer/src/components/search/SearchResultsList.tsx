import { Fragment, useEffect, useRef } from 'react'
import type { UIEvent } from 'react'
import { BookUser, FileText, History, Loader2, Mic } from 'lucide-react'
import type { SearchSnippet } from '../../../../shared/types/Search'
import { formatSwissDate } from '../../../../shared/utils/calendar-date'
import { sessionTitleIn } from '../../viewMode/sessionText'
import { useViewMode } from '../../viewMode/useViewMode'
import { dossierIdentification, dossierListName, pluralize } from '../../utils/dossierFormat'
import { hitLabel, optionId, UNTITLED_DOCUMENT, type SearchOption } from './searchOptions'

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
  /** Zuletzt gemerkte Scroll-Position; wird beim Einhängen wiederhergestellt. */
  initialScrollTop?: number
  /** Scrollen und Maus über der Liste (für «Liste nicht umsortieren»). */
  onScroll?: (scrollTop: number) => void
  onPointerActivity?: () => void
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
 * im Klartext (Hinweis «Ausschnitte im Klartext» am Fenster bzw. Seitenkopf);
 * exakte Stellen sind markiert, Treffer nach Bedeutung gepunktet unterstrichen.
 *
 * Der Fokus bleibt im Eingabefeld (Combobox mit `aria-activedescendant`);
 * Klicks verschieben ihn deshalb nicht.
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
  initialScrollTop = 0,
  onScroll,
  onPointerActivity,
  scrollable,
  before,
  after
}: SearchResultsListProps): React.JSX.Element {
  const viewMode = useViewMode()
  const listRef = useRef<HTMLDivElement>(null)
  const scrollRestored = useRef(false)

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

  const docCount = options.filter((o) => o.kind === 'document').length
  const indexOf = new Map(options.map((o, i) => [o.key, i]))

  const renderOption = (
    option: SearchOption,
    children: React.ReactNode,
    extra = ''
  ): React.JSX.Element => {
    const index = indexOf.get(option.key) ?? -1
    const active = option.key === activeKey
    return (
      <div
        key={option.key}
        id={optionId(listId, index)}
        role="option"
        aria-selected={active}
        data-anchor-id={option.key}
        // Fokus bleibt im Eingabefeld
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onSelect(option)}
        className={`cursor-pointer rounded-md transition-colors ${
          active ? 'bg-surface-2 ring-1 ring-primary' : 'hover:bg-surface-2'
        } ${extra}`}
      >
        {children}
      </div>
    )
  }

  const recent = options.filter((o) => o.kind === 'recent')
  const dossiers = options.filter((o) => o.kind === 'dossier')
  const documents = options.filter((o) => o.kind === 'document')

  return (
    <div
      ref={listRef}
      onScroll={(e: UIEvent<HTMLDivElement>) => onScroll?.(e.currentTarget.scrollTop)}
      onMouseMove={onPointerActivity}
      onWheel={onPointerActivity}
      className={scrollable ? 'min-h-0 flex-1 overflow-y-auto px-2 pb-2' : ''}
    >
      {before}
      <div id={listId} role="listbox" aria-label={label} className="flex flex-col gap-0.5">
        {recent.map((option) =>
          option.kind === 'recent'
            ? renderOption(
                option,
                <div className="flex items-center gap-2.5 px-2.5 py-2 text-sm text-text-primary">
                  <History
                    className="h-4 w-4 shrink-0 text-text-tertiary"
                    strokeWidth={1.75}
                    aria-hidden
                  />
                  <span className="truncate">{option.query}</span>
                </div>
              )
            : null
        )}

        {dossiers.length > 0 && (
          <div role="group" aria-labelledby={`${listId}-dossiers`} className="flex flex-col">
            <p
              id={`${listId}-dossiers`}
              className="px-2.5 pb-1 pt-2 text-xs font-semibold text-text-tertiary"
            >
              Patientendossiers
            </p>
            {dossiers.map((option) =>
              option.kind === 'dossier'
                ? renderOption(
                    option,
                    <div className="flex items-center gap-2.5 px-2.5 py-2 text-sm">
                      <BookUser
                        className="h-4 w-4 shrink-0 text-text-tertiary"
                        strokeWidth={1.75}
                        aria-hidden
                      />
                      <span className="truncate font-medium text-text-primary">
                        {dossierListName(option.dossier)}
                      </span>
                      {dossierIdentification(option.dossier) && (
                        <span className="truncate text-xs text-text-secondary">
                          {dossierIdentification(option.dossier)}
                        </span>
                      )}
                    </div>
                  )
                : null
            )}
          </div>
        )}

        {showDocumentsHeading && docCount > 0 && (
          <p
            role="presentation"
            className="px-2.5 pb-1 pt-3 text-xs font-semibold text-text-tertiary"
          >
            Sitzungen und PDF-Dokumente · {pluralize(docCount, 'Treffer', 'Treffer')}
          </p>
        )}

        {documents.map((docOption) => {
          if (docOption.kind !== 'document') return null
          const doc = docOption.doc
          const title = sessionTitleIn(doc, viewMode).trim() || UNTITLED_DOCUMENT
          const headerId = `${optionId(listId, indexOf.get(docOption.key) ?? -1)}-title`
          const hits = options.filter(
            (o): o is Extract<SearchOption, { kind: 'hit' }> =>
              o.kind === 'hit' && o.doc.sessionId === doc.sessionId
          )
          return (
            <div
              key={doc.sessionId}
              role="group"
              aria-labelledby={headerId}
              className="flex flex-col border-t border-border pt-1 first:border-t-0"
            >
              {renderOption(
                docOption,
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
                  <span id={headerId} className="min-w-0 truncate font-semibold text-text-primary">
                    {title}
                  </span>
                  <span className="text-xs text-text-secondary">
                    {formatSwissDate(doc.sortDay)}
                  </span>
                  {doc.dossiers.map((d) => (
                    <span
                      key={d.id}
                      className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-text-secondary"
                    >
                      {dossierListName(d)}
                    </span>
                  ))}
                </div>
              )}
              {hits.map((option) =>
                renderOption(
                  option,
                  <div className="flex gap-3 px-2.5 py-1.5 pl-8 text-sm">
                    <span className="w-24 shrink-0 text-xs leading-5 text-text-tertiary">
                      {hitLabel(option.hit, doc.type)}
                    </span>
                    <SnippetText
                      snippet={option.hit.snippet}
                      semantic={option.hit.kind === 'semantic'}
                    />
                  </div>
                )
              )}
            </div>
          )
        })}
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
