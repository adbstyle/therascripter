import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Search } from 'lucide-react'
import { useLiveQuery } from '../../hooks/useLiveQuery'
import { usePopoverPlacement } from '../../hooks/usePopoverPlacement'
import { useToast } from '../../hooks/useToast'
import { filterDossiers, prepareDossierFilter } from '../../utils/dossierFilter'
import {
  ambiguousDossierNames,
  dossierIdentification,
  dossierLabel,
  dossierListName
} from '../../utils/dossierFormat'
import type { DossierListItem, DossierRef } from '../../../../shared/types/Dossier'

/** Mehr Zeilen rendert die Auswahl nicht — die Suche grenzt ein (#205). */
export const MAX_RENDERED_DOSSIERS = 100

interface AssignDossiersPopoverProps {
  sessionId: string
  /** Titel in der gewählten Ansicht — für Überschrift und Fehlermeldungen. */
  sessionLabel: string
  /** Aktuell zugeordnete Dossiers (laden über `sessions:changed` nach). */
  assigned: DossierRef[]
  /** Schliessen (Esc, «Fertig», Klick daneben); der Aufrufer gibt den Fokus zurück. */
  onClose: () => void
}

interface Override {
  checked: boolean
  pending: boolean
}

/**
 * Auswahl zum Zuordnen und Lösen (#205 AK 1–3, 24), als Popover an der
 * Plakette — kein Modal. Jedes Häkchen wirkt sofort und wartet auf die
 * Antwort des Main-Prozesses; bis dahin ist die Zeile als «wird gespeichert»
 * markiert. Scheitert es, springt das Häkchen auf den vorherigen Stand zurück
 * und eine Meldung nennt Inhalt und Dossier.
 *
 * Zugeordnete Dossiers stehen oben (Stand beim Öffnen, damit die Liste beim
 * Anklicken nicht springt). Gleichnamige Dossiers unterscheidet die Zeile über
 * Dossier-ID und Geburtsdatum — auch im zugänglichen Namen der Checkbox.
 */
export function AssignDossiersPopover({
  sessionId,
  sessionLabel,
  assigned,
  onClose
}: AssignDossiersPopoverProps): React.JSX.Element {
  const toast = useToast()
  const headingId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [overrides, setOverrides] = useState<Map<string, Override>>(() => new Map())
  // Ansage für Screenreader: was ein Häkchen bewirkt hat (Sichtprüfung)
  const [announcement, setAnnouncement] = useState('')
  const pinnedRef = useRef<Set<string>>(new Set(assigned.map((d) => d.id)))

  const dossiers = useLiveQuery<DossierListItem[]>(
    () => window.api.dossiers.list(),
    [(cb) => window.api.dossiers.onChanged(() => cb())],
    []
  )

  // Erst nach dem ersten Laden der Liste sichtbar: vorher wäre das Popover
  // niedrig, öffnete unten und spränge nach dem Laden nach oben (Review #231).
  // Die Seite wird im selben Layout-Durchgang gemessen, in dem es erscheint.
  const ready = !(dossiers.loading && dossiers.data.length === 0)

  // Fokus in die Suche, sobald das Popover sichtbar ist (verborgene Elemente
  // nehmen keinen Fokus)
  useEffect(() => {
    if (ready) inputRef.current?.focus()
  }, [ready])

  const assignedIds = useMemo(() => new Set(assigned.map((d) => d.id)), [assigned])

  // Bestätigte Änderungen bleiben sichtbar, bis die Liste sie selbst zeigt
  useEffect(() => {
    setOverrides((prev) => {
      let changed = false
      const next = new Map(prev)
      for (const [id, override] of prev) {
        if (!override.pending && override.checked === assignedIds.has(id)) {
          next.delete(id)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [assignedIds])

  const prepared = useMemo(() => prepareDossierFilter(dossiers.data), [dossiers.data])
  const visible = useMemo(() => {
    const filtered = filterDossiers(prepared, deferredQuery)
    const pinned = pinnedRef.current
    return [
      ...filtered.filter((d) => pinned.has(d.id)),
      ...filtered.filter((d) => !pinned.has(d.id))
    ]
  }, [prepared, deferredQuery])
  const rendered = visible.slice(0, MAX_RENDERED_DOSSIERS)

  // Am unteren Fensterrand nach oben klappen, horizontal im Fenster bleiben (Sichtprüfung)
  const popoverRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const placement = usePopoverPlacement(
    popoverRef,
    listRef,
    `${dossiers.loading}:${dossiers.data.length}:${rendered.length}`
  )

  function isChecked(id: string): boolean {
    return overrides.get(id)?.checked ?? assignedIds.has(id)
  }

  async function toggle(dossier: DossierListItem): Promise<void> {
    const id = dossier.id
    if (overrides.get(id)?.pending) return
    const next = !isChecked(id)
    setOverrides((prev) => new Map(prev).set(id, { checked: next, pending: true }))
    let ok = false
    try {
      const result = next
        ? await window.api.dossiers.assign(sessionId, id)
        : await window.api.dossiers.unassign(sessionId, id)
      ok = result.ok
    } catch {
      ok = false
    }
    // Die Liste kennt alle Dossiers: gleichnamige mit Zusatz nennen
    const name = dossierLabel(dossier, ambiguousDossierNames(dossiers.data))
    if (ok) {
      setOverrides((prev) => new Map(prev).set(id, { checked: next, pending: false }))
      setAnnouncement(next ? `«${name}» zugeordnet.` : `Zuordnung zu «${name}» gelöst.`)
      return
    }
    setOverrides((prev) => {
      const map = new Map(prev)
      map.delete(id)
      return map
    })
    setAnnouncement(
      next
        ? `«${name}» konnte nicht zugeordnet werden.`
        : `Zuordnung zu «${name}» konnte nicht gelöst werden.`
    )
    toast.error(
      next
        ? `«${sessionLabel}» konnte dem Patientendossier «${name}» nicht zugeordnet werden.`
        : `Die Zuordnung von «${sessionLabel}» zum Patientendossier «${name}» konnte nicht gelöst werden.`
    )
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.stopPropagation()
      event.preventDefault()
      onClose()
    }
  }

  const trimmedQuery = query.trim()

  return (
    <div
      ref={popoverRef}
      role="dialog"
      aria-labelledby={headingId}
      onKeyDown={onKeyDown}
      data-placement={placement.side}
      style={{
        left: placement.offsetX,
        maxHeight: placement.maxHeight,
        visibility: ready ? undefined : 'hidden'
      }}
      className={`pointer-events-auto absolute z-30 flex w-[min(380px,calc(100vw-2rem))] flex-col gap-1 rounded-lg border border-border bg-surface-0 p-2 text-left shadow-lg ${
        placement.side === 'top' ? 'bottom-full mb-1' : 'top-full mt-1'
      }`}
    >
      <p id={headingId} className="sr-only">
        Patientendossiers für «{sessionLabel}» zuordnen
      </p>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <label className="flex shrink-0 items-center gap-2 rounded-md border border-border-strong px-2 py-1 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/30">
        <Search className="h-3.5 w-3.5 shrink-0 text-text-tertiary" strokeWidth={2} aria-hidden />
        <span className="sr-only">Patientendossier suchen</span>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Patientendossier suchen"
          className="min-w-0 flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none"
        />
      </label>

      <div ref={listRef} className="max-h-64 min-h-0 overflow-y-auto">
        {dossiers.loading && dossiers.data.length === 0 ? (
          <p className="px-2 py-2 text-xs text-text-tertiary">Wird geladen …</p>
        ) : dossiers.data.length === 0 ? (
          <p className="px-2 py-2 text-xs text-text-secondary">
            Noch keine Patientendossiers. Legen Sie eines unter «Alle Patientendossiers» an.
          </p>
        ) : rendered.length === 0 ? (
          <p className="px-2 py-2 text-xs text-text-secondary">
            Kein Patientendossier passt zu «{trimmedQuery}».
          </p>
        ) : (
          <ul className="flex flex-col">
            {rendered.map((dossier) => {
              const identification = dossierIdentification(dossier)
              const pending = overrides.get(dossier.id)?.pending === true
              return (
                <li key={dossier.id}>
                  <label
                    className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-surface-1"
                    aria-busy={pending || undefined}
                  >
                    <input
                      type="checkbox"
                      // Eindeutiger Name: «Meier, Anna (PD-0412 · 11.06.1969)»
                      aria-label={
                        identification
                          ? `${dossierListName(dossier)} (${identification})`
                          : dossierListName(dossier)
                      }
                      checked={isChecked(dossier.id)}
                      // aria-disabled statt disabled: ein deaktiviertes Element
                      // verlöre den Tastaturfokus; toggle() ignoriert Klicks solange
                      aria-disabled={pending || undefined}
                      onChange={() => void toggle(dossier)}
                      className="mt-0.5 h-4 w-4 shrink-0 accent-primary-solid"
                    />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-sm text-text-primary">
                        {dossierListName(dossier)}
                      </span>
                      {identification && (
                        <span className="truncate text-xs text-text-tertiary">
                          {identification}
                        </span>
                      )}
                      {pending && (
                        <span className="text-xs text-text-tertiary">Wird gespeichert …</span>
                      )}
                    </span>
                  </label>
                </li>
              )
            })}
          </ul>
        )}
        {visible.length > rendered.length && (
          <p className="px-2 py-1.5 text-xs text-text-tertiary">
            {visible.length - rendered.length} weitere — grenzen Sie die Suche ein.
          </p>
        )}
      </div>

      <div className="flex shrink-0 justify-end border-t border-border pt-1.5">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md px-3 py-1 text-sm font-medium text-primary hover:bg-surface-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          Fertig
        </button>
      </div>
    </div>
  )
}
