import type { TaskType } from '../types'

/**
 * Issue #80 / Phase F.1 — laienfreundliche, deutsche Schritt-Bezeichnungen.
 *
 * Single Source of Truth für AC#2 (keine ML-Fachbegriffe sichtbar).
 * Sie-Form, aktive Imperativ-Substantive. Diese Strings werden in der
 * SessionCard pro Pipeline-Schritt angezeigt und gelten für Audio + PDF.
 *
 * Wenn neue TaskType-Werte hinzukommen, muss dieser Record erweitert werden
 * (TypeScript zwingt das durch den Record-Typ).
 */
export const STEP_LABELS_DE: Record<TaskType, string> = {
  diarization: 'Sprecher unterscheiden',
  transcription: 'Gespräch transkribieren',
  alignment: 'Audio aufbereiten',
  anonymization: 'Persönliche Angaben anonymisieren',
  summarization: 'Zusammenfassung erstellen',
  extraction: 'Text auslesen',
  ocr: 'Schrift erkennen'
}

/**
 * UI-State-Strings.
 * Funktionen werden für formatierte Werte exportiert; reine Strings für
 * fixe Texte. Bei jeder Änderung das Snapshot-Test in Phase N anpassen.
 */
export const PIPELINE_UI_STRINGS = {
  waiting: (position: number): string => `Wartet — Position ${position}`,
  step: (i: number, n: number, label: string): string => `Schritt ${i}/${n} · ${label}`,
  preparingNext: 'Nächster Schritt wird vorbereitet…',
  etaMinutes: (n: number): string => `noch ca. ${n} Min.`,
  etaOneMinute: 'noch ca. 1 Min.',
  etaAlmostDone: 'Fast fertig',
  emptySpeechHeadline: 'Keine Sprache erkannt',
  emptySpeechBody: 'Sitzung wurde abgeschlossen, ohne dass Sprache erkannt wurde.',
  watchdogHeadline: 'Verarbeitung unterbrochen',
  watchdogBody: 'Die Verarbeitung wurde nach längerer Inaktivität abgebrochen.',
  retryButton: 'Erneut versuchen',
  retryAfterFirstFailure: 'Erster Versuch ist fehlgeschlagen.',
  retryAfterSecondFailure: 'Mehrfach-Fehler — bitte App neu starten oder Logs prüfen.',
  retryExhausted: 'Verarbeitung schlägt wiederholt fehl. Wenden Sie sich an den Support.'
} as const

/**
 * Format absolute total ETA (in seconds) into the user-facing string.
 * Returns null when no ETA is available so callers can hide the line.
 *
 * Schwellen (Plan §F):
 *   <30s  → "Fast fertig"
 *   30-60s → "noch ca. 1 Min."
 *   >60s  → "noch ca. N Min." (gerundet)
 */
export function formatEta(secondsTotal: number | null): string | null {
  if (secondsTotal == null) return null
  if (secondsTotal < 30) return PIPELINE_UI_STRINGS.etaAlmostDone
  if (secondsTotal < 60) return PIPELINE_UI_STRINGS.etaOneMinute
  const minutes = Math.round(secondsTotal / 60)
  return PIPELINE_UI_STRINGS.etaMinutes(minutes)
}
