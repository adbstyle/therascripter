import { useState } from 'react'
import BlocklistManager from '../components/BlocklistManager'
import AppearanceSettings from '../components/AppearanceSettings'
import AboutPage from '../components/AboutPage'
import ModelsSettings from '../components/settings/ModelsSettings'

type Tab = 'sperrliste' | 'darstellung' | 'modelle' | 'ueber'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'sperrliste', label: 'Sperrliste' },
  { id: 'darstellung', label: 'Darstellung' },
  { id: 'modelle', label: 'Modelle' },
  { id: 'ueber', label: 'Über' }
]

export default function Settings(): React.JSX.Element {
  const [currentTab, setCurrentTab] = useState<Tab>('sperrliste')

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Tabs */}
      <div className="border-b border-border px-6">
        <nav className="flex gap-6">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              className={`titlebar-no-drag border-b-2 px-1 py-3 text-sm font-medium transition-colors ${
                currentTab === tab.id
                  ? 'border-primary text-primary'
                  : 'border-transparent text-text-tertiary hover:border-border-strong hover:text-text-secondary'
              }`}
              onClick={() => setCurrentTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto">
        {currentTab === 'sperrliste' && <BlocklistManager />}
        {currentTab === 'darstellung' && <AppearanceSettings />}
        {currentTab === 'modelle' && <ModelsSettings />}
        {currentTab === 'ueber' && <AboutPage />}
      </div>
    </div>
  )
}
