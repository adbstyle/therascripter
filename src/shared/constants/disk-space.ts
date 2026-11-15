/**
 * Mindestens freier Speicherplatz für die Ersteinrichtung (Download plus
 * Entpacken): 5 GB dezimal (5 × 10^9 Bytes) — dieselbe Zahl wie README,
 * Website, Installationsanleitung und die Anzeige der App (formatBytes:
 * «5.0 GB»). Die Spitze beim Entpacken liegt bei ~2.85 GB, die Summe von
 * allem gepackt und entpackt bei ~3.8 GB (model-management.md).
 *
 * Eine andere Regel ist `MIN_FREE_AFTER_DOWNLOAD` im AppUpdateService (was
 * nach einem automatischen Update-Download frei bleiben muss).
 */
export const MINIMUM_DISK_SPACE_BYTES = 5_000_000_000
