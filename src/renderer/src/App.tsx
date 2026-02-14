import SessionDashboard from './components/SessionDashboard'

export default function App(): React.JSX.Element {
  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <aside className="flex w-[200px] flex-col border-r border-gray-200 bg-white px-4 py-6">
        <h1 className="titlebar-drag mb-8 text-base font-semibold text-gray-900">THERASCRIPT</h1>
        <nav className="flex flex-1 flex-col gap-1">
          <span className="titlebar-no-drag rounded-md bg-gray-100 px-3 py-2 text-sm font-medium text-gray-900">
            Sitzungen
          </span>
        </nav>
        <div className="flex items-center gap-1.5 text-xs text-gray-400">
          <span>&#128274;</span>
          <span>Lokal</span>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex flex-1 flex-col">
        {/* Header — draggable titlebar region */}
        <header className="titlebar-drag flex items-center justify-between border-b border-gray-200 px-6 py-4">
          <h2 className="text-2xl font-bold text-gray-900">Sitzungen</h2>
        </header>

        <SessionDashboard />
      </main>
    </div>
  )
}
