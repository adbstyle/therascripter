import { homedir } from 'os'

/**
 * Fehlermeldungen für Sitzungskarten (Sichtprüfung): Meldungen aus den
 * Verarbeitungsschritten nennen teils absolute Pfade («Audiodatei nicht
 * gefunden: /Users/<name>/.therascript/…») — auch in der gepackten App, etwa
 * wenn eine Aufnahme- oder Modelldatei fehlt. Solche Pfade verraten den
 * Benutzernamen und helfen Nutzer:innen nicht: Sie gehören ins Log, nicht auf
 * die Karte. Diese Funktion entfernt sie aus dem sichtbaren Text; der Aufrufer
 * loggt die vollständige Meldung.
 *
 * Drei Stufen (vorab: ein Pfad in Anführungszeichen wird samt Zeichen entfernt):
 * 1. Pfade unter dem Home-Verzeichnis (auch über `/Volumes/<Volume>/Users/…`,
 *    `userData` und das Datenverzeichnis liegen darunter) werden GEZIELT und
 *    vollständig ersetzt — Verzeichnisnamen dürfen Leerzeichen enthalten
 *    («Application Support», «Macintosh HD», «max muster»), solange danach
 *    noch ein «/» folgt. So bleibt weder Benutzername noch Pfadrest stehen.
 * 2. Übrige absolute Pfade (ohne Leerzeichen) nach Leerraum, Klammer,
 *    Anführungszeichen, «=» oder «[».
 * Danach werden leere Klammern/Anführungszeichen und verwaiste Doppelpunkte
 * getilgt. Normale Sätze («und/oder», «12/2026», URLs) bleiben unversehrt.
 */

const STOP = '\\s«»‹›"\'`()\\[\\]'
/** Verzeichnissegmente (mit Leerzeichen, wenn ein «/» folgt), dann das letzte ohne. */
const TAIL = `(?:/(?:[^/${STOP}]+(?: [^/${STOP}]+)*(?=/)))*(?:/[^/${STOP}]*)?`
/** Benutzerverzeichnis, auch mit Leerzeichen im Volume- oder Benutzernamen. */
const USERS_ROOT = `(?:/Volumes/[^/${STOP}]+(?: [^/${STOP}]+)*)?/Users/(?:[^/${STOP}]+(?: [^/${STOP}]+)*(?=/)|[^/${STOP}]+)`

const GENERIC_PATH = new RegExp(
  `(^|[\\s(«‹"'\`=\\[])((?:~|/)[^${STOP}]*/[^${STOP}]*?)([.,;:!?]*)(?=$|[\\s)»›"'\`\\]])`,
  'g'
)

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function defaultRoots(): string[] {
  try {
    const home = homedir()
    return home && home !== '/' ? [home] : []
  } catch {
    return []
  }
}

export function stripAbsolutePaths(message: string, roots: string[] = defaultRoots()): string {
  const known = [...roots]
    .filter((r) => r.length > 1)
    .sort((a, b) => b.length - a.length)
    .map((r) => escapeRegExp(r.replace(/\/+$/, '')))
  const targeted = new RegExp(`(?:${[...known, USERS_ROOT, '~'].join('|')})${TAIL}`, 'g')
  return (
    message
      // Ein Pfad in Anführungszeichen endet erst am schliessenden Zeichen
      // (auch Dateinamen mit Leerzeichen): ganz entfernen
      .replace(/«\s*(?:~|\/)[^»]*»|‹\s*(?:~|\/)[^›]*›|"\s*(?:~|\/)[^"]*"|'\s*(?:~|\/)[^']*'/g, '')
      .replace(targeted, (match) => {
        // «~» allein ist kein Pfad; ein Satzzeichen am Ende gehört zum Satz
        if (match === '~') return match
        const punct = /[.,;:!?]+$/.exec(match)?.[0] ?? ''
        return punct
      })
      .replace(GENERIC_PATH, (_m, before: string, _path: string, punct: string) => before + punct)
      // leere Reste: «», '', "", (), []
      .replace(/«\s*»|‹\s*›|"\s*"|'\s*'|`\s*`|\(\s*\)|\[\s*\]/g, '')
      .replace(/:\s*([.,;!?])/g, '$1')
      .replace(/\s+([.,;!?])/g, '$1')
      .replace(/[\s:=]+$/, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
  )
}
