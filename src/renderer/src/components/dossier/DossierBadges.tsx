import { useCallback, useEffect, useRef, useState } from 'react'
import type { FocusEvent } from 'react'
import { Plus } from 'lucide-react'
import { useClickOutside } from '../../hooks/useClickOutside'
import { dossierIdentification, dossierLabel, dossierListName } from '../../utils/dossierFormat'
import { useAmbiguousDossierNames } from '../../stores/dossierNames'
import { AssignDossiersPopover } from './AssignDossiersPopover'
import type { DossierRef } from '../../../../shared/types/Dossier'

interface DossierBadgesProps {
  sessionId: string
  /** Titel in der gewählten Ansicht (Überschrift und Meldungen der Auswahl). */
  sessionLabel: string
  dossiers: DossierRef[]
  /**
   * `list`: Plaketten öffnen die Auswahl, ohne Zuordnung «Dossier zuordnen».
   * `editor`: Plaketten öffnen das Dossier, daneben «Zuordnen».
   * `timeline`: nur die anderen Dossiers als «Auch in: …» (AK 7), sie öffnen
   * die Auswahl.
   */
  variant: 'list' | 'editor' | 'timeline'
  /** Verlauf: das Dossier der Seite — erscheint nicht als «Auch in». */
  currentDossierId?: string
  /** Editor: Dossier öffnen. */
  onOpenDossier?: (dossierId: string) => void
  /** Meldet, ob die Auswahl offen ist (der Editor hält dann Esc zurück). */
  onOpenChange?: (open: boolean) => void
}

const CHIP =
  'pointer-events-auto inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-px text-[11px] font-medium leading-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'
const SOLID_CHIP = `${CHIP} border-border bg-surface-0 text-text-secondary hover:border-border-strong hover:text-text-primary`
const DASHED_CHIP = `${CHIP} border-dashed border-border-strong bg-transparent text-text-secondary hover:text-text-primary`

function described(dossier: DossierRef): string {
  const identification = dossierIdentification(dossier)
  return identification
    ? `${dossierListName(dossier)} (${identification})`
    : dossierListName(dossier)
}

/**
 * Plaketten der Patientendossiers einer Sitzung (#205 AK 5) samt Einstieg in
 * die Auswahl zum Zuordnen und Lösen — auch während Aufnahme und
 * Verarbeitung (AK 3). Die Namen bleiben in beiden Ansichten sichtbar (OOS 9).
 */
export function DossierBadges({
  sessionId,
  sessionLabel,
  dossiers,
  variant,
  currentDossierId,
  onOpenDossier,
  onOpenChange
}: DossierBadgesProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const ambiguous = useAmbiguousDossierNames()
  const wrapperRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    onOpenChange?.(open)
  }, [open, onOpenChange])

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false)
    if (!returnFocus) return
    // Der Auslöser kann inzwischen ersetzt sein (erste Zuordnung: «Dossier
    // zuordnen» → Plakette; letzte gelöst: umgekehrt) — dann den ersten Knopf
    // der Plaketten fokussieren statt eines entfernten Elements
    const trigger = triggerRef.current
    if (trigger?.isConnected) trigger.focus()
    else {
      const wrapper = wrapperRef.current
      const fallback =
        wrapper?.querySelector<HTMLButtonElement>(':scope > button') ??
        wrapper?.closest('[data-session-id]')?.querySelector<HTMLButtonElement>('button')
      fallback?.focus()
    }
  }, [])
  const closeOnOutside = useCallback(() => {
    if (open) close(false)
  }, [open, close])
  useClickOutside(wrapperRef, closeOnOutside)

  function toggleFrom(button: HTMLButtonElement): void {
    triggerRef.current = button
    setOpen((current) => !current)
  }

  // Fokus verlässt die Plaketten samt Auswahl (Tab) — die Auswahl schliesst
  function onBlur(event: FocusEvent<HTMLDivElement>): void {
    const next = event.relatedTarget
    if (open && next instanceof Node && !wrapperRef.current?.contains(next)) close(false)
  }

  const shown =
    variant === 'timeline' ? dossiers.filter((d) => d.id !== currentDossierId) : dossiers
  // Bei offener Auswahl bleibt sie stehen, auch wenn gerade die letzte «Auch
  // in»-Zuordnung gelöst wurde — ein versehentliches Häkchen bleibt umkehrbar
  if (variant === 'timeline' && shown.length === 0 && !open) return null

  return (
    <div
      ref={wrapperRef}
      onBlur={onBlur}
      className="pointer-events-none relative flex min-w-0 flex-wrap items-center gap-1.5"
      role="group"
      aria-label="Patientendossiers"
    >
      {shown.map((dossier) =>
        variant === 'editor' ? (
          <button
            key={dossier.id}
            type="button"
            className={SOLID_CHIP}
            onClick={() => onOpenDossier?.(dossier.id)}
            aria-label={`Patientendossier ${described(dossier)} öffnen`}
            title={described(dossier)}
          >
            <span className="truncate">{dossierLabel(dossier, ambiguous)}</span>
          </button>
        ) : (
          <button
            key={dossier.id}
            type="button"
            className={SOLID_CHIP}
            onClick={(e) => toggleFrom(e.currentTarget)}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-label={`${variant === 'timeline' ? 'Auch in ' : 'Zugeordnet: '}${described(dossier)} – Zuordnungen bearbeiten`}
            title={described(dossier)}
          >
            <span className="truncate">
              {variant === 'timeline'
                ? `Auch in: ${dossierLabel(dossier, ambiguous)}`
                : dossierLabel(dossier, ambiguous)}
            </span>
          </button>
        )
      )}
      {(variant === 'editor' || (variant === 'list' && shown.length === 0)) && (
        <button
          type="button"
          className={DASHED_CHIP}
          onClick={(e) => toggleFrom(e.currentTarget)}
          aria-haspopup="dialog"
          aria-expanded={open}
        >
          <Plus className="h-2.5 w-2.5" strokeWidth={2.5} aria-hidden />
          {variant === 'editor' ? 'Zuordnen' : 'Dossier zuordnen'}
        </button>
      )}
      {open && (
        <AssignDossiersPopover
          sessionId={sessionId}
          sessionLabel={sessionLabel}
          assigned={dossiers}
          onClose={() => close(true)}
        />
      )}
    </div>
  )
}
