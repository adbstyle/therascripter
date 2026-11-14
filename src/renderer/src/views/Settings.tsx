import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ChevronRight, Cpu, Info, Palette, RefreshCw, ShieldCheck } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import BlocklistManager, { type BlocklistManagerHandle } from '../components/BlocklistManager'
import AppearanceSettings from '../components/AppearanceSettings'
import AboutPage from '../components/AboutPage'
import ModelsSettings from '../components/settings/ModelsSettings'
import UpdateSettings from '../components/settings/UpdateSettings'
import { useTheme } from '../hooks/useTheme'
import { useAppUpdate } from '../hooks/useAppUpdate'
import { updateTitle } from '../../../shared/utils/updateTitle'
import { PageHeader } from '../components/shell/PageHeader'
import { useScrollRestoration } from '../navigation/useScrollRestoration'
import type { SubPage } from '../navigation/routes'

export type { SubPage }

const SUBPAGE_TITLES: Record<SubPage, string> = {
  sperrliste: 'Sperrliste',
  darstellung: 'Darstellung',
  modelle: 'Modelle',
  updates: 'Updates',
  ueber: 'Über'
}

const THEME_LABELS = { light: 'Hell', dark: 'Dunkel', system: 'System' } as const

interface SettingsProps {
  /** Aktuelle Unterseite — Teil der Route, damit ‹ auch hier zurückführt (Epic #192). */
  subpage: SubPage | null
  onSubpageChange: (subpage: SubPage | null) => void
}

export default function Settings({ subpage, onSubpageChange }: SettingsProps): React.JSX.Element {
  const blocklistRef = useRef<BlocklistManagerHandle>(null)
  // Keine asynchronen Daten, die die Höhe bestimmen — sofort wiederherstellen
  useScrollRestoration(true)

  let headerAction: React.ReactNode = null
  if (subpage === 'sperrliste') {
    headerAction = (
      <button
        type="button"
        className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-hover"
        onClick={() => blocklistRef.current?.openAdd()}
      >
        + Eintrag hinzufügen
      </button>
    )
  }

  return (
    <div className="flex flex-1 flex-col">
      <SettingsHeader
        subpage={subpage}
        onBackToHome={() => onSubpageChange(null)}
        action={headerAction}
      />

      {subpage === null ? (
        <SettingsHome onSelect={onSubpageChange} />
      ) : (
        <div className="flex flex-1 flex-col">
          {subpage === 'sperrliste' && <BlocklistManager ref={blocklistRef} />}
          {subpage === 'darstellung' && <AppearanceSettings />}
          {subpage === 'modelle' && <ModelsSettings />}
          {subpage === 'updates' && <UpdateSettings />}
          {subpage === 'ueber' && <AboutPage />}
        </div>
      )}
    </div>
  )
}

interface HeaderProps {
  subpage: SubPage | null
  onBackToHome: () => void
  action?: React.ReactNode
}

function SettingsHeader({ subpage, onBackToHome, action }: HeaderProps): React.JSX.Element {
  let title: ReactNode = 'Einstellungen'
  if (subpage !== null) {
    // Brotkrümel: «Einstellungen» ist die übergeordnete Seite, kein Zurück im Verlauf
    title = (
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={onBackToHome}
          className="rounded-md text-xl font-semibold leading-7 text-text-tertiary transition-colors hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          Einstellungen
        </button>
        <ChevronRight
          className="h-5 w-5 shrink-0 text-text-tertiary"
          strokeWidth={2}
          aria-hidden="true"
        />
        <h1 className="truncate text-xl font-semibold leading-7 text-text-primary">
          {SUBPAGE_TITLES[subpage]}
        </h1>
      </div>
    )
  }
  return (
    <div className="px-6 pt-6">
      <PageHeader title={title} actions={action} />
    </div>
  )
}

interface HomeProps {
  onSelect: (page: SubPage) => void
}

function SettingsHome({ onSelect }: HomeProps): React.JSX.Element {
  const { theme } = useTheme()
  const { state: appUpdate, needsAttention: updateHighlighted } = useAppUpdate()

  const [blocklist, setBlocklist] = useState<{ entries: number; categories: number } | null>(null)
  const [modelLabels, setModelLabels] = useState<string[] | null>(null)
  const [appVersion, setAppVersion] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      window.api.blocklist.list(),
      window.api.modelCatalog.list('asr'),
      window.api.modelCatalog.list('diarization'),
      window.api.modelCatalog.list('ner'),
      window.api.system.aboutInfo()
    ])
      .then(([entries, asr, dia, ner, info]) => {
        if (cancelled) return
        const categories = new Set(entries.map((e) => e.placeholderType)).size
        setBlocklist({ entries: entries.length, categories })
        const activeLabels = [...asr, ...dia, ...ner].filter((m) => m.isActive).map((m) => m.label)
        setModelLabels(activeLabels)
        setAppVersion(info.version)
      })
      .catch(() => {
        // Fail silently — placeholders stay
      })
    return () => {
      cancelled = true
    }
  }, [])

  const blocklistSummary = blocklist
    ? `${blocklist.entries} Einträge · ${blocklist.categories} Kategorien`
    : 'Wird geladen…'

  const themeSummary = THEME_LABELS[theme]

  const modelSummary = modelLabels
    ? modelLabels.length > 0
      ? modelLabels.join(' · ')
      : 'Keine aktiven Modelle'
    : 'Wird geladen…'

  const aboutSummary = appVersion ? `v${appVersion}` : '…'

  const updateSummary = !appUpdate
    ? '…'
    : appUpdate.phase === 'ready'
      ? `${updateTitle(appUpdate)} bereit zur Installation`
      : appUpdate.phase === 'available' || appUpdate.phase === 'unsupported'
        ? `${updateTitle(appUpdate)} verfügbar`
        : `${appUpdate.autoUpdate ? 'Automatisch' : 'Von Hand'} · ${
            appUpdate.checkFailed
              ? 'Prüfung nicht gelungen'
              : appUpdate.checkedAt
                ? 'Aktuell'
                : 'Noch nicht geprüft'
          }`

  const items: SettingsItem[] = [
    {
      id: 'sperrliste',
      icon: ShieldCheck,
      title: 'Sperrliste',
      summary: blocklistSummary
    },
    {
      id: 'darstellung',
      icon: Palette,
      title: 'Darstellung',
      summary: themeSummary
    },
    {
      id: 'modelle',
      icon: Cpu,
      title: 'Modelle',
      summary: modelSummary
    },
    {
      id: 'updates',
      icon: RefreshCw,
      title: 'Updates',
      summary: updateSummary,
      summaryAccent: updateHighlighted ? 'primary' : undefined
    },
    {
      id: 'ueber',
      icon: Info,
      title: 'Über',
      summary: aboutSummary
    }
  ]

  return (
    <div className="p-6">
      <div className="mx-auto flex max-w-2xl flex-col gap-3">
        {items.map((item) => (
          <SettingsCard key={item.id} item={item} onClick={() => onSelect(item.id)} />
        ))}
      </div>
    </div>
  )
}

interface SettingsItem {
  id: SubPage
  icon: LucideIcon
  title: string
  summary: string
  badge?: string
  summaryAccent?: 'primary'
}

function SettingsCard({
  item,
  onClick
}: {
  item: SettingsItem
  onClick: () => void
}): React.JSX.Element {
  const { icon: Icon, title, summary, badge, summaryAccent } = item
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center gap-4 rounded-xl border border-border bg-surface-0 px-5 py-4 text-left transition-colors hover:border-border-strong hover:bg-surface-1"
    >
      <Icon
        className="h-7 w-7 shrink-0 text-text-tertiary transition-colors group-hover:text-text-secondary"
        strokeWidth={1.5}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-base font-semibold text-text-primary">{title}</span>
          {badge && (
            <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary">
              {badge}
            </span>
          )}
        </div>
        <p
          className={`mt-0.5 truncate text-sm ${
            summaryAccent === 'primary' ? 'text-primary' : 'text-text-tertiary'
          }`}
        >
          {summary}
        </p>
      </div>
      <ChevronRight
        className="h-5 w-5 shrink-0 text-text-tertiary transition-transform group-hover:translate-x-0.5 group-hover:text-text-secondary"
        strokeWidth={1.75}
        aria-hidden="true"
      />
    </button>
  )
}
