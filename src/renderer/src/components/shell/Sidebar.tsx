import { BookUser, FileUp, Files, Mic, Plus, Search } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useNavigation } from '../../navigation/navigation'
import { useRecordingState } from '../../contexts/recording'
import { useWorkspaceActions } from '../../contexts/workspaceActions'
import SidebarFooter from './SidebarFooter'
import RecentList from './RecentList'
import { openSearchModal } from '../../stores/searchSession'

/**
 * Seitenleiste der App (Epic #192, ersetzt die frühere untere Leiste).
 * Reihenfolge wie im abgenommenen Prototyp: Suchen ⌘K (#209) —
 * Transkriptionen mit PDF-Import und Aufnahme — Alle Patientendossiers mit
 * «Neues Patientendossier» (#204) — Zuletzt geöffnet (#213) — unten
 * Einstellungen, Update, Feedback.
 */
export default function Sidebar(): React.JSX.Element {
  const { route, navigate } = useNavigation()
  const { isRecording } = useRecordingState()
  const { startRecording, importPdfs, isImporting, openNewDossier } = useWorkspaceActions()
  const sessionsActive = route.kind === 'sessions'
  // Die Dossier-Seite gehört zum Bereich «Alle Patientendossiers»
  const dossiersActive =
    route.kind === 'dossiers' || route.kind === 'dossier' || route.kind === 'dossierSearch'

  return (
    <nav
      aria-label="Seitenleiste"
      className="flex w-[248px] shrink-0 flex-col gap-1 overflow-y-auto border-r border-border bg-surface-1 px-2 py-3"
    >
      {/* Suchfenster über alle Inhalte (#209); dasselbe wie ⌘K */}
      <button
        type="button"
        onClick={openSearchModal}
        aria-keyshortcuts="Meta+K"
        className="mb-1 flex items-center gap-2 rounded-md border border-border bg-surface-0 px-2.5 py-1.5 text-left text-[13px] font-medium leading-[18px] text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <Search className="h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden />
        <span className="flex-1">Suchen</span>
        <kbd aria-hidden="true" className="font-sans text-[11px] text-text-tertiary">
          ⌘K
        </kbd>
      </button>
      <SidebarRow
        icon={Files}
        label="Transkriptionen"
        active={sessionsActive}
        onClick={() => navigate({ kind: 'sessions' })}
      >
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
      </SidebarRow>
      <SidebarRow
        icon={BookUser}
        label="Alle Patientendossiers"
        active={dossiersActive}
        current={route.kind === 'dossiers'}
        onClick={() => navigate({ kind: 'dossiers' })}
      >
        <SidebarIconButton icon={Plus} label="Neues Patientendossier" onClick={openNewDossier} />
      </SidebarRow>
      <RecentList />
      <span className="flex-1" />
      <SidebarFooter />
    </nav>
  )
}

interface SidebarRowProps {
  icon: LucideIcon
  label: string
  /** Bereich ist aktiv (hervorgehoben), auch auf Unterseiten wie einem Dossier. */
  active: boolean
  /** Genau diese Seite ist offen (`aria-current`); Standard: wie `active`. */
  current?: boolean
  onClick: () => void
  children?: React.ReactNode
}

/** Bereichszeile mit Icon-Knöpfen rechts (wie im Prototyp). */
function SidebarRow({
  icon: Icon,
  label,
  active,
  current = active,
  onClick,
  children
}: SidebarRowProps): React.JSX.Element {
  return (
    <div
      className={`flex items-center gap-0.5 rounded-md ${
        active ? 'bg-surface-2 text-text-primary' : 'text-text-secondary'
      }`}
    >
      <button
        type="button"
        onClick={onClick}
        aria-current={current ? 'page' : undefined}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] font-medium leading-[18px] transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <Icon className="h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden />
        <span className="truncate">{label}</span>
      </button>
      {children}
    </div>
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
