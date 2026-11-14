import { normalizeUmlaut } from './blocklist-matching'

/** Unsichtbare Zeichen ohne Breite: Zero-Width Space/Non-Joiner/Joiner, BOM. */
const INVISIBLE = /[\u200B-\u200D\uFEFF]/g

/**
 * Vergleichsschlüssel für Namen und Patientendossier-IDs (#204 AK 5–7).
 *
 * Zwei Eingaben gelten als gleich, wenn sie sich nur in Gross-/Kleinschreibung,
 * in Leerzeichen am Anfang oder Ende oder in der Schreibweise von Umlauten
 * unterscheiden («Müller» = « mueller » = «MÜLLER»). Unsichtbare Zeichen
 * (U+200B–U+200D, U+FEFF) zählen nicht: «\u200BAnna» = «Anna».
 *
 * Reihenfolge ist wichtig:
 * 1. NFC — macOS liefert Eingaben teils zerlegt (NFD: `u` + U+0308). Ohne
 *    Komposition griffe die Umlaut-Regel nicht.
 * 2. unsichtbare Zeichen entfernen, trim, dann lowercase — `normalizeUmlaut`
 *    ersetzt nur Kleinbuchstaben; aus «Ä» wird so «ä» und daraus «ae», aus «ẞ»
 *    wird «ß» und daraus «ss».
 *
 * Einzige Implementierung der Gleichheitsregel: die `*_norm`-Spalten der
 * Tabelle `dossiers` schreibt ausschliesslich DossierService mit dieser
 * Funktion, SQL normalisiert nie selbst.
 */
export function normalizeDossierKey(value: string): string {
  return normalizeUmlaut(cleanDossierText(value).toLocaleLowerCase('de-CH'))
}

/**
 * Anzeigeform eines eingegebenen Namens bzw. einer Dossier-ID: zusammengesetzt
 * (NFC), ohne unsichtbare Zeichen, getrimmt.
 */
export function cleanDossierText(value: string): string {
  return value.normalize('NFC').replace(INVISIBLE, '').trim()
}

/**
 * Leer im Sinn von #204 AK 2: nach dem Entfernen von Leerraum und
 * unsichtbaren Zeichen bleibt nichts übrig (« », «\u200B» gelten als leer).
 */
export function isBlankDossierText(value: string): boolean {
  return value.replace(INVISIBLE, '').trim().length === 0
}

/** Steuerzeichen U+0000–U+001F und U+007F — in Namen und Dossier-ID nie erlaubt. */
export function hasControlChars(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001F\u007F]/.test(value)
}

/**
 * Wie hasControlChars, aber Zeilenumbruch (LF, CR) und Tab sind erlaubt —
 * für die mehrzeiligen Freitexte Diagnosen, Medikation und Notiz.
 */
export function hasControlCharsExceptLineBreaks(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)
}
