/**
 * Baut die Update-Beschreibung (manifest.json) aus dem Modell-Katalog des
 * Releases (Issue #163). Reine Funktion — scripts/manifest-from-catalog.ts
 * liefert Katalog, Live-Manifest und DMG-Daten, die Tests prüfen die Regeln.
 */

export interface ManifestModel {
  id: string
  version: string
  label: string
  url: string
  sha256: string
  sizeBytes: number
  minAppVersion?: string
}

export interface ManifestApp {
  version: string
  url: string
  sha256: string
  sizeBytes: number
}

export interface UpdateManifest {
  generatedAt: string
  latestAppVersion: string
  app: ManifestApp
  models: ManifestModel[]
}

export interface CatalogModel {
  id: string
  label: string
  url: string
  sha256: string
  sizeBytes: number
}

export interface BuildManifestInput {
  catalog: readonly CatalogModel[]
  /** Das aktuell veröffentlichte Manifest ({} wenn keins abrufbar). */
  live: { models?: ManifestModel[]; app?: ManifestApp }
  appVersion: string
  /** Installationspaket dieses Releases; ohne bleibt der Live-Eintrag (nur gleiche Version). */
  dmg?: { url: string; sha256: string; sizeBytes: number }
  now: Date
}

export function buildManifest(input: BuildManifestInput): UpdateManifest {
  const { catalog, live, appVersion, dmg, now } = input
  const today = now.toISOString().slice(0, 10)
  const liveModels = new Map((live.models ?? []).map((m) => [m.id, m]))

  const models = catalog.map((m): ManifestModel => {
    const previous = liveModels.get(m.id)
    const unchanged = previous !== undefined && previous.sha256 === m.sha256
    return {
      id: m.id,
      // Rein informativ (Updates löst der sha-Vergleich aus) — ein
      // unverändertes Artefakt behält sein Datum.
      version: unchanged ? previous.version : today,
      label: m.label,
      url: m.url,
      sha256: m.sha256,
      sizeBytes: m.sizeBytes,
      // Ab welcher App-Version das Artefakt passt (AK 2): ein unverändertes
      // behält seinen Wert, ein neues gilt erst ab der App, die es mitbringt.
      minAppVersion: (unchanged && previous.minAppVersion) || appVersion
    }
  })

  let app: ManifestApp
  if (dmg) {
    app = { version: appVersion, ...dmg }
  } else if (live.app?.version === appVersion) {
    app = live.app
  } else {
    throw new Error(
      `Kein DMG und das Live-Manifest beschreibt nicht die App ${appVersion} — ` +
        'App-Eintrag fehlt (Release: release.sh übergibt das DMG)'
    )
  }

  return {
    generatedAt: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    latestAppVersion: appVersion,
    app,
    models
  }
}
