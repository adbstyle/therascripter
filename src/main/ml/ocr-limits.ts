/**
 * Zeitgrenzen der Vision-OCR (eigenes Modul ohne Electron-Import, damit
 * ProcessWatchdog und Tests sie lesen können).
 *
 * Der ERSTE Aufruf von Apple Vision in einem Benutzerkonto ohne Vision-Cache
 * dauert auf macOS 27 25–35 s (gemessen auf M5 Pro: frisches Home 25.8 s,
 * echtes Home nach längerer Pause 35 s), jeder weitere ~0.25 s. Die frühere
 * Grenze von 30 s liess deshalb die erste eingescannte Seite scheitern.
 * 120 s lassen dem Kaltstart auch auf langsameren Macs Luft und fangen eine
 * wirklich hängende Seite trotzdem in zwei Minuten ab.
 */
export const OCR_PAGE_TIMEOUT_MS = 120_000

/**
 * Stall-Schwelle des Watchdogs für den OCR-Schritt. vision-ocr meldet
 * während einer Seite nichts (kein Fortschritt, kein Lebenszeichen); der
 * Executor meldet Fortschritt nur nach jeder fertigen Seite. Die Schwelle
 * muss deshalb über Seiten-Timeout + SIGTERM→SIGKILL-Gnadenfrist (5 s) plus
 * Poll-Intervall liegen: dann endet eine hängende Seite immer über das
 * Seiten-Timeout mit einer verständlichen Meldung, und der Watchdog bleibt
 * reines Sicherheitsnetz (z. B. falls der Executor selbst hängt).
 */
export const OCR_STALL_THRESHOLD_MS = OCR_PAGE_TIMEOUT_MS + 30_000
