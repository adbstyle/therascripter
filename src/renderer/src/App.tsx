export default function App(): React.JSX.Element {
  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <aside className="flex w-[200px] flex-col border-r border-gray-200 bg-white px-4 py-6">
        <h1 className="mb-8 text-base font-semibold text-gray-900">THERASCRIPT</h1>
        <nav className="flex flex-1 flex-col gap-1">
          <span className="rounded-md bg-gray-100 px-3 py-2 text-sm font-medium text-gray-900">
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
        {/* Header */}
        <header className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
          <h2 className="text-2xl font-bold text-gray-900">Sitzungen</h2>
        </header>

        {/* Empty state */}
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <p className="mb-1 text-lg font-medium text-gray-600">Keine Sitzungen</p>
            <p className="mb-6 text-sm text-gray-400">
              Starten Sie eine Aufnahme oder importieren Sie ein PDF-Dokument.
            </p>
          </div>
        </div>
      </main>
    </div>
  )
}
