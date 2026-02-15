import { useState } from 'react'
import BlocklistManager from '../components/BlocklistManager'

type Tab = 'sperrliste' | 'modelle' | 'ueber'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'sperrliste', label: 'Sperrliste' },
  { id: 'modelle', label: 'Modelle' },
  { id: 'ueber', label: 'Über' }
]

export default function Settings(): React.JSX.Element {
  const [currentTab, setCurrentTab] = useState<Tab>('sperrliste')

  return (
    <div className="flex flex-1 flex-col">
      {/* Tabs */}
      <div className="border-b border-gray-200 px-6">
        <nav className="flex gap-6">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              className={`titlebar-no-drag border-b-2 px-1 py-3 text-sm font-medium transition-colors ${
                currentTab === tab.id
                  ? 'border-primary text-primary'
                  : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700'
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
        {currentTab === 'modelle' && (
          <div className="flex flex-1 items-center justify-center p-8">
            <p className="text-sm text-gray-400">Modell-Verwaltung — noch nicht implementiert</p>
          </div>
        )}
        {currentTab === 'ueber' && (
          <div className="flex flex-1 items-center justify-center p-8">
            <p className="text-sm text-gray-400">Über Therascript — noch nicht implementiert</p>
          </div>
        )}
      </div>
    </div>
  )
}
