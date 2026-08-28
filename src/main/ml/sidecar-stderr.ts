// Gemeinsamer stderr-Zeilen-Parser für die Python-Sidecars (ner_service.py,
// diarize.py). Beide sprechen dasselbe Protokoll:
//
//   [PROGRESS] 42   Fortschritt in Prozent
//   [HEARTBEAT]     reines Lebenszeichen, ohne Fortschritt
//
// Der Heartbeat existiert, weil der ProcessWatchdog Liveness misst und nicht
// Fortschritt: beide Sidecars haben Phasen von mehreren Minuten ohne jedes
// [PROGRESS] (Modell-Load; bei NER zusätzlich die Inferenz eines einzigen
// Batches). Auf RAM-knappen Macs ist dieser Load fast reiner I/O-Wait
// (gemessen 281 s wall / 42 s CPU bei vollem Swap) und lag damit weit über
// der Stall-Schwelle — der Watchdog killte einen gesunden Prozess.

// Progress line format: "[PROGRESS] 42"
const PROGRESS_REGEX = /\[PROGRESS\]\s*(\d+)/
// Liveness line format: "[HEARTBEAT]"
const HEARTBEAT_REGEX = /\[HEARTBEAT\]/

export type SidecarStderrEvent =
  | { kind: 'progress'; progress: number }
  | { kind: 'heartbeat' }
  | null

/**
 * Klassifiziert eine stderr-Zeile eines Python-Sidecars. Beide Signale müssen
 * den Watchdog zurücksetzen, aber nur [PROGRESS] darf den Fortschrittswert
 * bewegen — ein Heartbeat, der Progress schreibt, würde die Balken im
 * Renderer flackern lassen und den in der DB persistierten Wert verfälschen.
 */
export function parseSidecarStderrLine(line: string): SidecarStderrEvent {
  const match = PROGRESS_REGEX.exec(line)
  if (match) {
    return { kind: 'progress', progress: parseInt(match[1], 10) / 100 }
  }
  if (HEARTBEAT_REGEX.test(line)) {
    return { kind: 'heartbeat' }
  }
  return null
}
