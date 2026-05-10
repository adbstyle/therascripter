import { useState } from 'react'
import { AnonymizationPanel } from '../editor/AnonymizationPanel'
import { SecondaryTabs } from '../editor/SecondaryTabs'
import { ProvenancePanel } from './ProvenancePanel'
import type { AnonymizationOverviewData } from '../../hooks/useAnonymizationOverview'
import type { PlaceholderType, ProcessedModelsSnapshot } from '../../../../shared/types'

type TabId = 'anonymization' | 'provenance'

interface ReviewSidePanelProps {
  isOpen: boolean
  anonymization: AnonymizationOverviewData
  onRevert: (entityId: string) => void
  onChangeType: (entityId: string, newType: PlaceholderType) => void
  onAddToBlocklist: (entityId: string, original: string, type: PlaceholderType) => void
  provenance: ProcessedModelsSnapshot | null
  reviewAt: string | null
}

const ID_PREFIX = 'review-side'

export function ReviewSidePanel({
  isOpen,
  anonymization,
  onRevert,
  onChangeType,
  onAddToBlocklist,
  provenance,
  reviewAt
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
      className={`flex-shrink-0 overflow-hidden transition-[width] duration-200 ease-in-out ${
        isOpen ? 'w-[300px]' : 'w-0'
      }`}
    >
      {/*
       * `inert` on the inner container removes the entire side panel from
       * the keyboard tab order and the accessibility tree while it is
       * collapsed (AC9). The width transition still plays so the close
       * animation shows content sliding out instead of jump-cutting.
       */}
      <div
        className="flex h-full w-[300px] flex-col border-l border-border bg-surface-1"
        inert={!isOpen}
      >
        <SecondaryTabs
          tabs={tabs}
          activeId={activeTab}
          onChange={setActiveTab}
          ariaLabel="Side-Panel-Bereiche"
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
          <ProvenancePanel data={provenance} reviewAt={reviewAt} />
        </div>
      </div>
    </div>
  )
}
