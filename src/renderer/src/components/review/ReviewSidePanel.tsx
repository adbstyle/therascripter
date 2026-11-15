import { useState } from 'react'
import type { Ref } from 'react'
import { X } from 'lucide-react'
import { AnonymizationPanel } from '../editor/AnonymizationPanel'
import { SecondaryTabs } from '../editor/SecondaryTabs'
import { ProvenancePanel } from './ProvenancePanel'
import type { AnonymizationOverviewData } from '../../hooks/useAnonymizationOverview'
import type { AudioStats, PlaceholderType, ProcessedModelsSnapshot } from '../../../../shared/types'

type TabId = 'anonymization' | 'provenance'

interface ReviewSidePanelProps {
  isOpen: boolean
  /** Issue #203 — Klartext view: list only, no actions that change the session. */
  readOnly?: boolean
  anonymization: AnonymizationOverviewData
  onRevert: (entityId: string) => void
  onChangeType: (entityId: string, newType: PlaceholderType) => void
  onAddToBlocklist: (entityId: string, original: string, type: PlaceholderType) => void
  provenance: ProcessedModelsSnapshot | null
  reviewAt: string | null
  audioStats: AudioStats | null
  /**
   * Schmale Textspalte: das Panel liegt als Überlagerung über dem Text statt
   * daneben und hat einen eigenen Schliessen-Knopf.
   */
  overlay?: boolean
  onClose?: () => void
  /** Fokusziel beim Öffnen der Überlagerung. */
  panelRef?: Ref<HTMLDivElement>
}

const ID_PREFIX = 'review-side'

export function ReviewSidePanel({
  isOpen,
  readOnly = false,
  anonymization,
  onRevert,
  onChangeType,
  onAddToBlocklist,
  provenance,
  reviewAt,
  audioStats,
  overlay = false,
  onClose,
  panelRef
}: ReviewSidePanelProps): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<TabId>('anonymization')

  const tabs = [
    {
      id: 'anonymization' as const,
      label: 'Pseudonymisierungen',
      badge: anonymization.totalChips
    },
    { id: 'provenance' as const, label: 'Verarbeitung' }
  ]

  return (
    <div
      className={
        overlay
          ? `absolute inset-y-0 right-0 z-30 w-[300px] overflow-hidden shadow-xl ${
              isOpen ? '' : 'hidden'
            }`
          : `flex-shrink-0 overflow-hidden transition-[width] duration-200 ease-in-out ${
              isOpen ? 'w-[300px]' : 'w-0'
            }`
      }
      data-overlay={overlay ? 'true' : undefined}
    >
      {/*
       * `inert` on the inner container removes the entire side panel from
       * the keyboard tab order and the accessibility tree while it is
       * collapsed (AC9). The width transition still plays so the close
       * animation shows content sliding out instead of jump-cutting.
       */}
      <div
        ref={panelRef}
        tabIndex={-1}
        className="flex h-full w-[300px] flex-col border-l border-border bg-surface-1 focus:outline-none"
        inert={!isOpen}
      >
        {overlay && (
          <div className="flex justify-end border-b border-border px-2 py-1">
            <button
              type="button"
              onClick={onClose}
              aria-label="Übersicht schliessen"
              title="Schliessen (Esc)"
              className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <X className="h-4 w-4" strokeWidth={2} aria-hidden />
            </button>
          </div>
        )}
        <SecondaryTabs
          tabs={tabs}
          activeId={activeTab}
          onChange={setActiveTab}
          ariaLabel="Bereiche der Übersicht"
          idPrefix={ID_PREFIX}
        />
        <div
          role="tabpanel"
          id={`${ID_PREFIX}-panel-anonymization`}
          aria-labelledby={`${ID_PREFIX}-tab-anonymization`}
          tabIndex={0}
          hidden={activeTab !== 'anonymization'}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <AnonymizationPanel
            data={anonymization}
            readOnly={readOnly}
            onRevert={onRevert}
            onChangeType={onChangeType}
            onAddToBlocklist={onAddToBlocklist}
          />
        </div>
        <div
          role="tabpanel"
          id={`${ID_PREFIX}-panel-provenance`}
          aria-labelledby={`${ID_PREFIX}-tab-provenance`}
          tabIndex={0}
          hidden={activeTab !== 'provenance'}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <ProvenancePanel data={provenance} reviewAt={reviewAt} audioStats={audioStats} />
        </div>
      </div>
    </div>
  )
}
