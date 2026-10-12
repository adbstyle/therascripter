/**
 * Zustand des Updates in der App (Issues #164, #165, #167). App und Modelle
 * sind ein Vorgang: ein Update kann eine neue App-Version, neue Fassungen
 * der installierten Modelle und Pflichtmodelle der neuen Version enthalten.
 * Der Main-Prozess (AppUpdateService) besitzt den Zustand und schickt jede
 * Änderung an den Renderer.
 *
 * - idle: kein Update bekannt (aktuell, noch nie geprüft oder Prüfung gescheitert
 *   — siehe checkedAt/checkFailed)
 * - available: Update bekannt, noch nicht vollständig geladen (automatische
 *   Updates aus, zu wenig Speicher oder ein Hintergrund-Download ist
 *   gescheitert) — braucht immer die Aufmerksamkeit der Nutzer:in
 * - downloading: Download, Prüfung und Bereitstellen laufen (alle Teile)
 * - ready: alle Teile liegen geprüft bereit und werden gemeinsam installiert
 * - unsupported: nur eine neue App-Version, die sich nicht selbst ersetzen
 *   kann — Weg über die Website
 */
export type AppUpdatePhase = 'idle' | 'available' | 'downloading' | 'ready' | 'unsupported'

/** Ein Modell im Update. */
export interface AppUpdateModel {
  id: string
  label: string
  sizeBytes: number
  /** update = neue Fassung eines installierten Modells, new = braucht die neue Version */
  kind: 'update' | 'new'
}

export interface AppUpdateState {
  phase: AppUpdatePhase
  currentVersion: string
  /** Neue App-Version im Update; null = reines Modell-Update (oder kein Update). */
  version: string | null
  /** Gesamte Download-Grösse aller Teile in Bytes (AK 3). */
  sizeBytes: number | null
  /** Download-Grösse des App-Teils, null ohne neue App-Version. */
  appSizeBytes: number | null
  /** Modelle im Update. */
  models: AppUpdateModel[]
  /** Freier Speicher, den das Bereitstellen noch braucht (vor dem Start, NFR 1). */
  diskNeedBytes: number | null
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
  /**
   * Warum sich die App nicht selbst ersetzen kann. Gesetzt, sobald es eine
   * neuere Version gibt, die nur von Hand installiert werden kann — dann
   * nennt manualVersion sie. Modell-Updates laufen trotzdem (phase).
   */
  unsupportedReason: string | null
  manualVersion: string | null
  /** Letzte erfolgreiche Prüfung (ISO), null solange keine gelungen ist. */
  checkedAt: string | null
  /** Die letzte Prüfung ist gescheitert (offline, Signatur ungültig, Server). */
  checkFailed: boolean
}

/** Ergebnis von appUpdate:install. */
export type AppUpdateInstallResult =
  | { status: 'installing' }
  | { status: 'pending'; reason: 'recording' | 'processing' | 'download' }
  | { status: 'not-ready' }
