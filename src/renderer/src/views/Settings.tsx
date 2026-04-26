import { useEffect, useState } from 'react'
import { ArrowLeft, ChevronRight, Cpu, Info, Palette, ShieldCheck } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import BlocklistManager from '../components/BlocklistManager'
import AppearanceSettings from '../components/AppearanceSettings'
import AboutPage from '../components/AboutPage'
import ModelsSettings from '../components/settings/ModelsSettings'
import { useTheme } from '../hooks/useTheme'
import { useAppUpdate } from '../hooks/useAppUpdate'
import { useModelUpdates } from '../hooks/useModelUpdates'

type SubPage = 'sperrliste' | 'darstellung' | 'modelle' | 'ueber'

const SUBPAGE_TITLES: Record<SubPage, string> = {
  sperrliste: 'Sperrliste',
  darstellung: 'Darstellung',
  modelle: 'Modelle',
  ueber: 'Über'
}

const THEME_LABELS = { light: 'Hell', dark: 'Dunkel', system: 'System' } as const

export default function Settings(): React.JSX.Element {
  const [subpage, setSubpage] = useState<SubPage | null>(null)

  if (subpage === null) {
    return <SettingsHome onSelect={setSubpage} />
  }

  return (
    <SettingsSubPage title={SUBPAGE_TITLES[subpage]} onBack={() => setSubpage(null)}>
      {subpage === 'sperrliste' && <BlocklistManager />}
      {subpage === 'darstellung' && <AppearanceSettings />}
      {subpage === 'modelle' && <ModelsSettings />}
      {subpage === 'ueber' && <AboutPage />}
    </SettingsSubPage>
  )
}

interface SubPageProps {
  title: string
  onBack: () => void
  children: React.ReactNode
}

function SettingsSubPage({ title, onBack, children }: SubPageProps): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border px-6 py-3">
        <button
          type="button"
          onClick={onBack}
          className="titlebar-no-drag inline-flex items-center gap-1.5 rounded-md px-2 py-1 -ml-2 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-1 hover:text-text-primary"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
          Einstellungen
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        <div className="px-6 pt-6">
          <h2 className="text-2xl font-bold text-text-primary">{title}</h2>
        </div>
        {children}
      </div>
    </div>
  )
}

interface HomeProps {
  onSelect: (page: SubPage) => void
}

function SettingsHome({ onSelect }: HomeProps): React.JSX.Element {
  const { theme } = useTheme()
  const { status: appUpdateStatus } = useAppUpdate()
  const { availableUpdates } = useModelUpdates()

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
        const activeLabels = [...asr, ...dia, ...ner]
          .filter((m) => m.isActive)
          .map((m) => m.label)
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

  const aboutSummary = appVersion
    ? `v${appVersion} · ${appUpdateStatus?.available ? 'Update verfügbar' : 'Aktuell'}`
    : '…'

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
      summary: modelSummary,
      badge: availableUpdates && availableUpdates.length > 0 ? 'Update' : undefined
    },
    {
      id: 'ueber',
      icon: Info,
      title: 'Über',
      summary: aboutSummary,
      summaryAccent: appUpdateStatus?.available ? 'primary' : undefined
    }
  ]

  return (
    <div className="overflow-y-auto p-6">
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
      className="titlebar-no-drag group flex w-full items-center gap-4 rounded-xl border border-border bg-surface-0 px-5 py-4 text-left transition-colors hover:border-border-strong hover:bg-surface-1"
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
