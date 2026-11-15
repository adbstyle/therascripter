/**
 * Grössen in der App: dezimal wie macOS/Finder und alle öffentlichen Texte
 * (1 GB = 10^9 Bytes, 1 MB = 10^6, 1 KB = 10^3). Einheitlich für
 * Ersteinrichtung, Einstellungen › Modelle, Updates, Suchmodell und
 * Speicherplatz-Meldungen — sonst zeigte die App «2.0 GB», wo Finder, README
 * und Website «2.1 GB» sagen.
 *
 * Schwellen (z. B. 5 GiB Mindestplatz) bleiben, wie sie sind; nur die Anzeige
 * folgt dieser Regel.
 */
export const BYTES_PER_KB = 1e3
export const BYTES_PER_MB = 1e6
export const BYTES_PER_GB = 1e9

/**
 * «512 B», «340 KB», «547 MB», «2.1 GB». Die Einheit richtet sich nach dem
 * gerundeten Wert — 999'600 Bytes sind «1 MB», nicht «1000 KB».
 */
export function formatBytes(bytes: number): string {
  if (bytes < BYTES_PER_KB) return `${bytes} B`
  const kb = Math.round(bytes / BYTES_PER_KB)
  if (kb < 1000) return `${kb} KB`
  const mb = Math.round(bytes / BYTES_PER_MB)
  if (mb < 1000) return `${mb} MB`
  return `${(bytes / BYTES_PER_GB).toFixed(1)} GB`
}

/** Ganze GB, aufgerundet — für «mindestens N GB frei». */
export function ceilGigabytes(bytes: number): number {
  return Math.ceil(bytes / BYTES_PER_GB)
}
