/**
 * Blockierte Werkzeuge (Issue #168). macOS beendet ein eingebautes Werkzeug
 * (whisper-cli, Python, llama-cli, vision-ocr) beim Start, wenn eine seiner
 * Programmdateien die Programm-Freigabe nicht trägt. Geteilt zwischen
 * Main-Prozess (Erkennen, Meldungen) und Oberfläche (Banner, Sitzungskarte).
 */

export type BlockedTool = 'whisper' | 'python' | 'llama' | 'ocr'

export const BLOCKED_TOOLS: readonly BlockedTool[] = ['whisper', 'python', 'llama', 'ocr']

/** Was ohne das Werkzeug nicht geht (AK 5) — Sie-Form, ohne Fachbegriffe. */
export const TOOL_FEATURES: Record<BlockedTool, string> = {
  whisper: 'Transkription',
  python: 'Sprechererkennung und Pseudonymisierung',
  llama: 'Zusammenfassung',
  ocr: 'Texterkennung in gescannten PDFs'
}

export interface ToolHealthState {
  /** checking: Prüfung läuft; ok: alles nutzbar; blocked: siehe tools. */
  status: 'checking' | 'ok' | 'blocked'
  tools: BlockedTool[]
  /** Pfad der App — für den Befehl, falls kein anderer Weg hilft (AK 4). */
  bundlePath: string
}

/** Erkennungsmerkmal der Fehlermeldung — die Sitzung speichert nur Text. */
const MESSAGE_PREFIX = 'macOS hat ein Werkzeug von Therascript blockiert'

/**
 * Meldung bei einer Sitzung, deren Verarbeitung an einem blockierten Werkzeug
 * scheiterte (PC 1). repaired: Therascript hat die Blockade inzwischen selbst
 * behoben, ein erneuter Versuch genügt.
 */
export function toolBlockedMessage(tool: BlockedTool, repaired: boolean): string {
  const feature = TOOL_FEATURES[tool]
  return repaired
    ? `${MESSAGE_PREFIX} (${feature}). Therascript hat das inzwischen behoben — bitte versuchen Sie es erneut.`
    : `${MESSAGE_PREFIX} (${feature}). Folgen Sie dem Hinweis oben in der App und versuchen Sie es danach erneut.`
}

export function isToolBlockedMessage(message: string | null | undefined): boolean {
  return typeof message === 'string' && message.startsWith(MESSAGE_PREFIX)
}

/** Fehler eines blockierten Werkzeugs — trägt die verständliche Meldung. */
export class ToolBlockedError extends Error {
  constructor(
    readonly tool: BlockedTool,
    readonly repaired: boolean
  ) {
    super(toolBlockedMessage(tool, repaired))
    this.name = 'ToolBlockedError'
  }
}
