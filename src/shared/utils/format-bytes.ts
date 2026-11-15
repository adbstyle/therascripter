/**
 * Grössen in der App: dezimal wie macOS/Finder und alle öffentlichen Texte
 * (1 GB = 10^9 Bytes, 1 MB = 10^6, 1 KB = 10^3). Einheitlich für
 * Ersteinrichtung, Einstellungen › Modelle, Updates, Suchmodell und
 * Speicherplatz-Meldungen — sonst zeigte die App «2.0 GB», wo Finder, README
 * und Website «2.1 GB» sagen.
 *
 * Der Mindestplatz der Ersteinrichtung ist ebenfalls dezimal (5 GB,
 * `shared/constants/disk-space.ts`).
 */
export const BYTES_PER_KB = 1e3
export const BYTES_PER_MB = 1e6
export const BYTES_PER_GB = 1e9

/**
 * «512 B», «340 KB», «547 MB», «2.1 GB». Die Einheit richtet sich nach dem
 * gerundeten Wert — 999'600 Bytes sind «1 MB», nicht «1000 KB». Ungültige
 * Werte (negativ, NaN, unendlich) ergeben «—».
 *
 * `floor`: abrunden statt runden — für «Verfügbar», damit bei zu wenig Platz
 * nie «Verfügbar: 5.0 GB» neben «Benötigt: 5.0 GB» steht.
 */
export function formatBytes(bytes: number, options: { floor?: boolean } = {}): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < BYTES_PER_KB) return `${Math.floor(bytes)} B`
  const round = options.floor ? Math.floor : Math.round
  const kb = round(bytes / BYTES_PER_KB)
  if (kb < 1000) return `${kb} KB`
  const mb = round(bytes / BYTES_PER_MB)
  if (mb < 1000) return `${mb} MB`
  if (options.floor) return `${(Math.floor(bytes / 1e8) / 10).toFixed(1)} GB`
  return `${(bytes / BYTES_PER_GB).toFixed(1)} GB`
}

/** Ganze GB, aufgerundet — für «mindestens N GB frei». */
export function ceilGigabytes(bytes: number): number {
  return Math.ceil(bytes / BYTES_PER_GB)
}
