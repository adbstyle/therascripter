/**
 * Zustand des App-Updates in der App (Issues #164, #165). Der Main-Prozess
 * (AppUpdateService) besitzt ihn und schickt jede Änderung an den Renderer.
 *
 * - idle: aktuell (oder noch nie geprüft)
 * - available: neuere Version bekannt, noch nicht geladen (automatische
 *   Updates aus, zu wenig Speicher oder ein Hintergrund-Download wird später
 *   still wiederholt)
 * - downloading: Download, Prüfung und Bereitstellen laufen
 * - ready: neue Version liegt geprüft bereit und kann installiert werden
 * - unsupported: die App kann sich nicht selbst ersetzen — Weg über die Website
 */
export type AppUpdatePhase = 'idle' | 'available' | 'downloading' | 'ready' | 'unsupported'

export interface AppUpdateState {
  phase: AppUpdatePhase
  currentVersion: string
  /** Angebotene bzw. bereitliegende Version. */
  version: string | null
  /** Download-Grösse des Installationspakets in Bytes. */
  sizeBytes: number | null
  /** 0–100 während eines selbst gestarteten Downloads, sonst null. */
  progress: number | null
  /** true, wenn der laufende Download selbst gestartet wurde (nur dann sichtbar). */
  manualDownload: boolean
  /** Einstellung «Automatische Updates» (#165). */
  autoUpdate: boolean
  /** Installation gewählt, wartet auf das Ende von Aufnahme/Verarbeitung (AK 15). */
  installPending: boolean
  /**
   * Hinweis zum letzten Fehler (Deutsch, mit nächstem Schritt), z. B. eine
   * gescheiterte Installation (AK 16). null, wenn alles in Ordnung ist.
   */
  message: string | null
  /** Warum sich die App nicht selbst ersetzen kann (phase 'unsupported'). */
  unsupportedReason: string | null
  checkedAt: string | null
}

/** Ergebnis von appUpdate:install. */
export type AppUpdateInstallResult =
  | { status: 'installing' }
  | { status: 'pending'; reason: 'recording' | 'processing' | 'download' }
  | { status: 'not-ready' }
