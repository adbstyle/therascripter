import { normalizeUmlaut } from './blocklist-matching'

/**
 * Vergleichsschlüssel für Namen und Patientendossier-IDs (#204 AK 5–7).
 *
 * Zwei Eingaben gelten als gleich, wenn sie sich nur in Gross-/Kleinschreibung,
 * in Leerzeichen am Anfang oder Ende oder in der Schreibweise von Umlauten
 * unterscheiden («Müller» = « mueller » = «MÜLLER»).
 *
 * Reihenfolge ist wichtig:
 * 1. NFC — macOS liefert Eingaben teils zerlegt (NFD: `u` + U+0308). Ohne
 *    Komposition griffe die Umlaut-Regel nicht.
 * 2. trim, dann lowercase — `normalizeUmlaut` ersetzt nur Kleinbuchstaben;
 *    aus «Ä» wird so «ä» und daraus «ae», aus «ẞ» wird «ß» und daraus «ss».
 *
 * Einzige Implementierung der Gleichheitsregel: die `*_norm`-Spalten der
 * Tabelle `dossiers` schreibt ausschliesslich DossierService mit dieser
 * Funktion, SQL normalisiert nie selbst.
 */
export function normalizeDossierKey(value: string): string {
  return normalizeUmlaut(value.normalize('NFC').trim().toLocaleLowerCase('de-CH'))
}

/** Anzeigeform eines eingegebenen Werts: zusammengesetzt (NFC) und getrimmt. */
export function cleanDossierText(value: string): string {
  return value.normalize('NFC').trim()
}
