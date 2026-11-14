import { FileUp, Files, Mic } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useNavigation } from '../../navigation/navigation'
import { useRecordingState } from '../../contexts/recording'
import { useWorkspaceActions } from '../../contexts/workspaceActions'
import SidebarFooter from './SidebarFooter'

/**
 * Seitenleiste der App (Epic #192, ersetzt die frühere untere Leiste).
 * Reihenfolge wie im abgenommenen Prototyp: (Suchen, ab #209) —
 * Transkriptionen mit PDF-Import und Aufnahme — (Alle Patientendossiers, ab
 * #204) — (Zuletzt geöffnet, ab #213) — unten Einstellungen, Update, Feedback.
 */
export default function Sidebar(): React.JSX.Element {
  const { route, navigate } = useNavigation()
  const { isRecording } = useRecordingState()
  const { startRecording, importPdfs, isImporting } = useWorkspaceActions()
  const sessionsActive = route.kind === 'sessions'

  return (
    <nav
      aria-label="Seitenleiste"
      className="flex w-[248px] shrink-0 flex-col gap-1 overflow-y-auto border-r border-border bg-surface-1 px-2 py-3"
    >
      {/* Platz für «Suchen ⌘K» (#209) */}
      <div
        className={`flex items-center gap-0.5 rounded-md ${
          sessionsActive ? 'bg-surface-2 text-text-primary' : 'text-text-secondary'
        }`}
      >
        <button
          type="button"
          onClick={() => navigate({ kind: 'sessions' })}
          aria-current={sessionsActive ? 'page' : undefined}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] font-medium leading-[18px] transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <Files className="h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden />
          <span className="truncate">Transkriptionen</span>
        </button>
        <SidebarIconButton
          icon={FileUp}
          label="PDF importieren"
          disabled={isImporting}
          onClick={() => void importPdfs()}
        />
        <SidebarIconButton
          icon={Mic}
          label={isRecording ? 'Aufnahme läuft bereits' : 'Aufnahme starten'}
          disabled={isRecording}
          tone="recording"
          onClick={() => void startRecording()}
        />
      </div>
      {/* Platz für «Alle Patientendossiers» (#204) und «Zuletzt geöffnet» (#213) */}
      <span className="flex-1" />
      <SidebarFooter />
    </nav>
  )
}

interface SidebarIconButtonProps {
  icon: LucideIcon
  label: string
  disabled?: boolean
  tone?: 'recording'
  onClick: () => void
}

function SidebarIconButton({
  icon: Icon,
  label,
  disabled,
  tone,
  onClick
}: SidebarIconButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={`inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md transition-colors last:mr-1 hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-40 ${
        tone === 'recording' ? 'text-recording' : 'text-text-secondary hover:text-text-primary'
      }`}
    >
      <Icon className="h-4 w-4" strokeWidth={1.75} aria-hidden />
    </button>
  )
}
