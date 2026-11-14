import { useId } from 'react'
import { BookUser, FileText, Mic } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useLiveQuery } from '../../hooks/useLiveQuery'
import { useNavigation } from '../../navigation/navigation'
import { useViewMode } from '../../viewMode/useViewMode'
import { sessionTitleIn } from '../../viewMode/sessionText'
import { dossierListName } from '../../utils/dossierFormat'
import type { Route } from '../../navigation/routes'
import type { RecentEntry } from '../../../../shared/types/Recent'
import type { ViewMode } from '../../../../shared/types/ViewMode'

interface Item {
  key: string
  icon: LucideIcon
  /** Art des Eintrags als zugänglicher Name des Icons (AK 3). */
  kindLabel: string
  /** Name in der gewählten Ansicht (AK 4). */
  label: string
  recording: boolean
  current: boolean
  open: () => void
}

function toItem(
  entry: RecentEntry,
  mode: ViewMode,
  route: Route,
  navigate: ReturnType<typeof useNavigation>['navigate']
): Item {
  if (entry.kind === 'dossier') {
    const { dossier } = entry
    return {
      key: `dossier:${dossier.id}`,
      icon: BookUser,
      kindLabel: 'Patientendossier',
      // Namen von Dossiers verdeckt die pseudonymisierte Ansicht nicht (Epic OOS 16)
      label: dossierListName(dossier),
      recording: false,
      current: route.kind === 'dossier' && route.dossierId === dossier.id,
      open: () => navigate({ kind: 'dossier', dossierId: dossier.id })
    }
  }
  const { session } = entry
  const title = sessionTitleIn(session, mode).trim()
  const isPdf = session.type === 'pdf'
  return {
    key: `session:${session.id}`,
    icon: isPdf ? FileText : Mic,
    kindLabel: isPdf ? 'PDF-Dokument' : 'Sitzung',
    label: title.length > 0 ? title : 'Unbenannte Transkription',
    recording: entry.recording,
    current: route.kind === 'session' && route.sessionId === session.id,
    // Nur Fertiges öffnet den Editor; alles andere zeigt die Sitzungsliste
    // und hebt dort die Karte hervor (laufende Aufnahme, Verarbeitung, Fehler)
    open: () =>
      session.status === 'review'
        ? navigate({ kind: 'session', sessionId: session.id })
        : navigate({ kind: 'sessions' }, { targetAnchorId: session.id })
  }
}

/**
 * «Zuletzt geöffnet» in der Seitenleiste (#213): höchstens acht Dossiers,
 * Sitzungen und PDF-Dokumente gemischt, das zuletzt geöffnete zuerst, eine
 * laufende Aufnahme vor allen anderen (Reihenfolge aus dem Main-Prozess).
 * Lädt bei jeder Änderung nach, die Titel, Namen, Zustand oder Liste
 * betrifft; gelöschte Einträge verschwinden so sofort (PC 2).
 *
 * Kein Klarname in der pseudonymisierten Ansicht: Text, `title` und
 * zugänglicher Name der Knöpfe bestehen nur aus Art und angezeigtem Titel.
 */
export default function RecentList(): React.JSX.Element {
  const { route, navigate } = useNavigation()
  const mode = useViewMode()
  const headingId = useId()
  const recent = useLiveQuery<RecentEntry[]>(
    () => window.api.recent.list(),
    [
      (cb) => window.api.recent.onChanged(() => cb()),
      (cb) => window.api.sessions.onChanged(() => cb()),
      (cb) => window.api.dossiers.onChanged(() => cb())
    ],
    []
  )
  const items = recent.data.map((entry) => toItem(entry, mode, route, navigate))

  return (
    <section aria-labelledby={headingId} className="mt-3 flex flex-col gap-0.5">
      <h2
        id={headingId}
        className="px-2.5 pb-1 text-[11px] font-medium uppercase tracking-[0.04em] text-text-secondary"
      >
        Zuletzt geöffnet
      </h2>
      {items.length === 0 ? (
        !recent.loading && (
          <p className="px-2.5 py-1 text-xs leading-[17px] text-text-secondary">
            Geöffnete Dossiers und Transkriptionen erscheinen hier.
          </p>
        )
      ) : (
        <ul className="flex flex-col gap-0.5">
          {items.map((item) => (
            <li key={item.key}>
              <RecentItemButton item={item} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function RecentItemButton({ item }: { item: Item }): React.JSX.Element {
  const Icon = item.icon
  return (
    <button
      type="button"
      onClick={item.open}
      aria-current={item.current ? 'page' : undefined}
      title={`${item.kindLabel}: ${item.label}`}
      className={`flex w-full min-w-0 items-center gap-2 rounded-md px-2.5 py-[5px] text-left text-[13px] leading-[18px] transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
        item.current ? 'bg-surface-2 text-text-primary' : 'text-text-secondary'
      }`}
    >
      <Icon
        className="h-3.5 w-3.5 shrink-0"
        strokeWidth={1.75}
        role="img"
        aria-label={item.kindLabel}
      />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.recording && (
        <span
          role="img"
          aria-label="Aufnahme läuft"
          className="h-[7px] w-[7px] shrink-0 animate-pulse rounded-full bg-recording"
        />
      )}
    </button>
  )
}
