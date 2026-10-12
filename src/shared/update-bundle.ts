import type { ManifestApp } from './update-manifest'
import type { BundleModel, ManifestModelInput } from './validation/model-update-schemas'
import { isNewerVersion } from './version'

/**
 * Was gehört zu einem Update (Issue #167)? App und Modelle sind ein Vorgang:
 * eine neuere App, sofern sich die App selbst ersetzen kann, dazu neue
 * Fassungen der installierten Modelle und die Pflichtmodelle, die erst die
 * neue Version braucht. Rein und ohne Dateizugriff — die Fragen an Festplatte
 * und Einstellungen beantwortet der Aufrufer (SelectContext).
 */

/** Ablage eines Modells, wie sie der Katalog dieser App kennt. */
export interface LocalLayout {
  id: string
  relativePath: string
  checkPath: string
  archive: boolean
  required: boolean
}

export interface UpdateBundle {
  /** Neue App-Version; null = reines Modell-Update. */
  app: ManifestApp | null
  models: BundleModel[]
}

export interface SelectContext {
  currentVersion: string
  /** false: App-Teil fällt weg (Weg über die Anleitung), Modelle bleiben. */
  appInstallable: boolean
  localLayouts: readonly LocalLayout[]
  retiredIds: ReadonlySet<string>
  /** Installierte Fassung; '' = unbekannt (Altbestand), null = kein Eintrag. */
  installedSha: (id: string) => string | null
  /** Liegt der Prüfpfad (relativ zu models/) auf der Festplatte? */
  isOnDisk: (checkPath: string) => boolean
}

/** Ein Pfad gleich, über oder unter dem anderen — ein Tausch träfe beide. */
function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

function sameLayout(a: LocalLayout, b: Omit<LocalLayout, 'id' | 'required'>): boolean {
  return a.relativePath === b.relativePath && a.checkPath === b.checkPath && a.archive === b.archive
}

export function selectBundle(
  manifest: { app?: ManifestApp; models: readonly ManifestModelInput[] },
  ctx: SelectContext
): UpdateBundle | null {
  const app =
    manifest.app && ctx.appInstallable && isNewerVersion(ctx.currentVersion, manifest.app.version)
      ? manifest.app
      : null
  // Version nach dem Update — dagegen prüft minAppVersion (AK 6)
  const target = app?.version ?? ctx.currentVersion
  const local = new Map(ctx.localLayouts.map((l) => [l.id, l]))

  const resolved: Array<{ entry: ManifestModelInput; layout: LocalLayout }> = []
  for (const entry of manifest.models) {
    if (ctx.retiredIds.has(entry.id)) continue
    const known = local.get(entry.id)
    const layout: LocalLayout | null =
      entry.relativePath && entry.checkPath
        ? {
            id: entry.id,
            relativePath: entry.relativePath,
            checkPath: entry.checkPath,
            archive: entry.archive === true,
            required: entry.required ?? known?.required ?? false
          }
        : (known ?? null)
    if (!layout) continue
    // Ohne neue App muss das Modell dort liegen, wo diese App es sucht
    if (!app && known && !sameLayout(known, layout)) continue
    resolved.push({ entry, layout })
  }

  const models: BundleModel[] = []
  for (const { entry, layout } of resolved) {
    if (entry.minAppVersion && isNewerVersion(target, entry.minAppVersion)) continue
    // Ein Archiv ersetzt seinen ganzen Ordner — nie, wenn dort ein anderes Modell liegt
    const others = [
      ...ctx.localLayouts.filter((l) => l.id !== entry.id),
      ...resolved.filter((r) => r.entry.id !== entry.id).map((r) => r.layout)
    ]
    if (others.some((o) => overlaps(o.relativePath, layout.relativePath))) continue
    if (models.some((m) => m.id === entry.id)) continue

    let kind: BundleModel['kind']
    if (ctx.isOnDisk(layout.checkPath)) {
      if (ctx.installedSha(entry.id) === entry.sha256) continue
      kind = 'update'
    } else if (app && layout.required) {
      // Braucht erst die neue Version — kommt im selben Vorgang mit (AK 4)
      kind = 'new'
    } else {
      // Nicht installierte Wahlmodelle werden nie angeboten
      continue
    }
    models.push({
      id: entry.id,
      version: entry.version,
      label: entry.label,
      url: entry.url,
      sha256: entry.sha256,
      sizeBytes: entry.sizeBytes,
      ...(entry.minAppVersion ? { minAppVersion: entry.minAppVersion } : {}),
      relativePath: layout.relativePath,
      checkPath: layout.checkPath,
      archive: layout.archive,
      required: layout.required,
      kind
    })
  }

  if (!app && models.length === 0) return null
  return { app, models }
}

/** Gleicher Schlüssel = gleiches Update (Version bzw. Prüfsumme jedes Teils). */
export function bundleKey(bundle: UpdateBundle): string {
  const parts = bundle.models.map((m) => `${m.id}@${m.sha256}`).sort()
  if (bundle.app) parts.unshift(`app@${bundle.app.version}@${bundle.app.sha256}`)
  return parts.join('|')
}

/** Gesamte Download-Grösse (AK 3). */
export function bundleBytes(bundle: UpdateBundle): number {
  return (bundle.app?.sizeBytes ?? 0) + bundle.models.reduce((sum, m) => sum + m.sizeBytes, 0)
}

/**
 * Speicherbedarf, um ein Modell bereitzustellen: ein Archiv liegt kurz
 * gepackt und entpackt nebeneinander, die bisherige Fassung bleibt bis zum
 * nächsten Start als Sicherung. Bewusst grosszügig — lieber ein Hinweis zu
 * viel als ein voller Mac (NFR 1).
 */
export function modelStagingBytes(model: Pick<BundleModel, 'sizeBytes' | 'archive'>): number {
  return Math.ceil(model.sizeBytes * (model.archive ? 2.5 : 1))
}
