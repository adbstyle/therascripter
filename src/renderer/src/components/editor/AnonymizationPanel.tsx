import { useCallback, useMemo, useRef, useState } from 'react'
import { MoreHorizontal, Undo2 } from 'lucide-react'
import type { EntitySource, PlaceholderType } from '../../../../shared/types'
import {
  CHIP_STYLES,
  SOURCE_LABELS,
  formatPlaceholderLabel
} from '../../constants/editorConstants'
import type {
  AnonymizationOverviewData,
  EntityTypeGroup,
  AnonymizedIdentity,
  OriginalVariant
} from '../../hooks/useAnonymizationOverview'
import { ChipActionMenu } from './ChipActionMenu'

interface AnonymizationPanelProps {
  data: AnonymizationOverviewData
  onRevert: (entityId: string) => void
  onChangeType: (entityId: string, newType: PlaceholderType) => void
  onAddToBlocklist: (entityId: string, original: string, type: PlaceholderType) => void
}

/**
 * Pseudonymisierungs-Liste — content-only. The outer side-panel chrome
 * (width transition, border, surface) and the tab strip with the count
 * badge live in `ReviewSidePanel`. This component renders only the
 * scrollable list body.
 */
export function AnonymizationPanel({
  data,
  onRevert,
  onChangeType,
  onAddToBlocklist
}: AnonymizationPanelProps): React.JSX.Element {
  if (data.totalIdentities === 0) {
    return (
      <p className="px-3 py-8 text-center text-sm text-text-tertiary">
        Keine Pseudonymisierungen
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-4 px-3 py-3">
      {data.groups.map((group) => (
        <TypeGroupSection
          key={group.type}
          group={group}
          onRevert={onRevert}
          onChangeType={onChangeType}
          onAddToBlocklist={onAddToBlocklist}
        />
      ))}
    </div>
  )
}

function TypeGroupSection({
  group,
  onRevert,
  onChangeType,
  onAddToBlocklist
}: {
  group: EntityTypeGroup
  onRevert: (entityId: string) => void
  onChangeType: (entityId: string, newType: PlaceholderType) => void
  onAddToBlocklist: (entityId: string, original: string, type: PlaceholderType) => void
}): React.JSX.Element {
  const chipStyle = CHIP_STYLES[group.type] ?? CHIP_STYLES.SONSTIGES

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${chipStyle}`}>
          {group.label}
        </span>
      </div>
      <div className="flex flex-col gap-2">
        {group.identities.map((identity) => (
          <IdentityRow
            key={identity.entityId}
            identity={identity}
            onRevert={onRevert}
            onChangeType={onChangeType}
            onAddToBlocklist={onAddToBlocklist}
          />
        ))}
      </div>
    </div>
  )
}

function IdentityRow({
  identity,
  onRevert,
  onChangeType,
  onAddToBlocklist
}: {
  identity: AnonymizedIdentity
  onRevert: (entityId: string) => void
  onChangeType: (entityId: string, newType: PlaceholderType) => void
  onAddToBlocklist: (entityId: string, original: string, type: PlaceholderType) => void
}): React.JSX.Element {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [menuRect, setMenuRect] = useState<DOMRect | null>(null)
  const chipStyle = CHIP_STYLES[identity.type] ?? CHIP_STYLES.SONSTIGES
  const displayLabel = formatPlaceholderLabel(identity.type, identity.number)

  const isBlocklistSourced = useMemo(
    () => identity.variants.some((v) => v.source === 'blocklist'),
    [identity.variants]
  )
  const entitySource: EntitySource = isBlocklistSourced ? 'blocklist' : 'ner'

  const openMenu = useCallback(() => {
    if (!triggerRef.current) return
    setMenuRect(triggerRef.current.getBoundingClientRect())
  }, [])

  const closeMenu = useCallback((reason: 'activated' | 'dismissed') => {
    setMenuRect(null)
    /*
     * Only refocus the trigger on dismissal (Escape, outside click, Tab).
     * On activation the ReviewEditor handler owns focus — it dispatches the
     * doc mutation and calls editor.commands.focus(), possibly after an
     * `await` for the IPC in handleChipAddToBlocklist. Refocusing here would
     * race the async path and steal focus from the editor, leaving Cmd+Z
     * bound to the wrong target (Postcondition #4).
     */
    if (reason === 'dismissed') triggerRef.current?.focus()
  }, [])

  const menuOpen = menuRect !== null

  return (
    <div className="rounded-lg border border-border bg-surface-0 px-3 py-2">
      <div className="flex items-center justify-between">
        <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${chipStyle}`}>
          {displayLabel}
        </span>
        <div className="flex items-center gap-0.5">
          <button
            ref={triggerRef}
            type="button"
            className="flex h-6 w-6 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:bg-surface-2 focus-visible:text-text-primary focus-visible:outline-none"
            onClick={openMenu}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`Weitere Aktionen für ${displayLabel}`}
            title={`Weitere Aktionen für ${displayLabel}`}
          >
            <MoreHorizontal className="h-4 w-4" strokeWidth={1.75} aria-hidden />
          </button>
          <button
            type="button"
            className="flex h-6 w-6 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:bg-surface-2 focus-visible:text-text-primary focus-visible:outline-none"
            onClick={() => onRevert(identity.entityId)}
            aria-label={`Pseudonym ${displayLabel} entfernen`}
            title={
              identity.totalCount > 1
                ? `Pseudonym entfernen (${identity.totalCount} Vorkommen)`
                : 'Pseudonym entfernen'
            }
          >
            <Undo2 className="h-4 w-4" strokeWidth={1.75} aria-hidden />
          </button>
        </div>
      </div>
      <div className="mt-1.5 flex flex-col gap-1">
        {identity.variants.map((variant) => (
          <VariantRow key={`${variant.source}::${variant.text}`} variant={variant} />
        ))}
      </div>
      {menuRect && (
        <ChipActionMenu
          anchorRect={menuRect}
          entityId={identity.entityId}
          entityType={identity.type}
          entityNumber={identity.number}
          entitySource={entitySource}
          original={identity.canonicalVariant.text}
          occurrenceCount={identity.totalCount}
          onUndo={onRevert}
          onChangeType={onChangeType}
          onAddToBlocklist={onAddToBlocklist}
          onClose={closeMenu}
          showUndoItem={false}
        />
      )}
    </div>
  )
}

function VariantRow({ variant }: { variant: OriginalVariant }): React.JSX.Element {
  const sourceInfo = SOURCE_LABELS[variant.source] ?? SOURCE_LABELS.ner

  return (
    <div className="flex items-center gap-1.5 text-xs text-text-secondary">
      <span className="truncate" title={variant.text}>
        &ldquo;{variant.text}&rdquo;
      </span>
      {variant.count > 1 && (
        <span className="flex-shrink-0 text-text-tertiary">{variant.count}x</span>
      )}
      <sourceInfo.icon
        className="h-3.5 w-3.5 flex-shrink-0 text-text-tertiary"
        strokeWidth={1.75}
        aria-label={sourceInfo.label}
      />
    </div>
  )
}
