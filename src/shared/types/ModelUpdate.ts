/**
 * Installierte Fassung eines Modells (Einstellung installedModelVersions,
 * pro Kanal, siehe InstalledVersionsStore). sha256 '' = unbekannt (Altbestand
 * vor der Versionsverfolgung); die Update-Prüfung heilt bzw. aktualisiert ihn.
 * Update-Beschreibung und Update-Pakete: shared/validation/model-update-schemas.ts,
 * shared/update-bundle.ts.
 */
export interface InstalledModelVersion {
  version: string
  sha256: string
  installedAt: string
}
