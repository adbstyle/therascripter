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

interface AnonymizationPanelProps {
  data: AnonymizationOverviewData
  onRevert: (entityId: string) => void
}

/**
 * Pseudonymisierungs-Liste — content-only. The outer side-panel chrome
 * (width transition, border, surface) and the tab strip with the count
 * badge live in `ReviewSidePanel`. This component renders only the
 * scrollable list body.
 */
export function AnonymizationPanel({
  data,
  onRevert
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
        <TypeGroupSection key={group.type} group={group} onRevert={onRevert} />
      ))}
    </div>
  )
}

function TypeGroupSection({
  group,
  onRevert
}: {
  group: EntityTypeGroup
  onRevert: (entityId: string) => void
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
          <IdentityRow key={identity.entityId} identity={identity} onRevert={onRevert} />
        ))}
      </div>
    </div>
  )
}

function IdentityRow({
  identity,
  onRevert
}: {
  identity: AnonymizedIdentity
  onRevert: (entityId: string) => void
}): React.JSX.Element {
  const chipStyle = CHIP_STYLES[identity.type] ?? CHIP_STYLES.SONSTIGES
  const displayLabel = formatPlaceholderLabel(identity.type, identity.number)

  return (
    <div className="rounded-lg border border-border bg-surface-0 px-3 py-2">
      <div className="flex items-center justify-between">
        <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${chipStyle}`}>
          {displayLabel}
        </span>
        <button
          className="flex h-6 w-6 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-surface-2 hover:text-text-primary"
          onClick={() => onRevert(identity.entityId)}
          title={`${displayLabel} rückgängig machen (${identity.totalCount} Vorkommen)`}
          aria-label={`${displayLabel} rückgängig machen`}
        >
          &#8617;
        </button>
      </div>
      <div className="mt-1.5 flex flex-col gap-1">
        {identity.variants.map((variant) => (
          <VariantRow key={`${variant.source}::${variant.text}`} variant={variant} />
        ))}
      </div>
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
