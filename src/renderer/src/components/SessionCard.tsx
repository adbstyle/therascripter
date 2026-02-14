import { useRef, useState } from 'react'
import type { Session, SessionStatus } from '../../../shared/types'
import { useClickOutside } from '../hooks/useClickOutside'

interface SessionCardProps {
  session: Session
  onRename: () => void
  onDelete: () => void
}

const STATUS_CONFIG: Record<SessionStatus, { label: string; color: string }> = {
  recording: { label: 'Aufnahme läuft', color: 'text-recording' },
  transcribing: { label: 'Transkription', color: 'text-primary' },
  diarizing: { label: 'Sprechererkennung', color: 'text-primary' },
  extracting: { label: 'Textextraktion', color: 'text-primary' },
  anonymizing: { label: 'Anonymisierung', color: 'text-primary' },
  review: { label: 'Review', color: 'text-success' },
  error: { label: 'Fehler', color: 'text-red-600' }
}

export function SessionCard({ session, onRename, onDelete }: SessionCardProps): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useClickOutside(menuRef, () => setMenuOpen(false))

  const statusConfig = STATUS_CONFIG[session.status]
  const typeIcon = session.type === 'audio' ? '\uD83C\uDFA4' : '\uD83D\uDCC4'

  return (
    <div className="group relative flex items-center gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3 transition-colors hover:border-gray-300">
      <span className="text-lg" aria-hidden="true">
        {typeIcon}
      </span>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-gray-900">{session.title}</p>
        <div className="flex items-center gap-2">
          <span className={`text-xs font-medium ${statusConfig.color}`}>
            {statusConfig.label}
          </span>
          {session.status === 'error' && session.errorMessage && (
            <span className="truncate text-xs text-gray-400">{session.errorMessage}</span>
          )}
        </div>
      </div>

      <div className="relative" ref={menuRef}>
        <button
          className="rounded p-1 text-gray-400 opacity-0 transition-opacity hover:bg-gray-100 hover:text-gray-600 group-hover:opacity-100"
          onClick={() => setMenuOpen(!menuOpen)}
          aria-label="Sitzungsoptionen"
        >
          <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 16 16">
            <circle cx="8" cy="3" r="1.5" />
            <circle cx="8" cy="8" r="1.5" />
            <circle cx="8" cy="13" r="1.5" />
          </svg>
        </button>

        {menuOpen && (
          <div className="absolute right-0 top-full z-10 mt-1 w-40 rounded-md border border-gray-200 bg-white py-1 shadow-lg">
            <button
              className="w-full px-3 py-1.5 text-left text-sm text-gray-700 hover:bg-gray-50"
              onClick={() => {
                setMenuOpen(false)
                onRename()
              }}
            >
              Umbenennen
            </button>
            <button
              className="w-full px-3 py-1.5 text-left text-sm text-red-600 hover:bg-red-50"
              onClick={() => {
                setMenuOpen(false)
                onDelete()
              }}
            >
              Löschen
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
