/**
 * Fehlermeldungen für Sitzungskarten (Sichtprüfung): Meldungen aus den
 * Verarbeitungsschritten nennen teils absolute Pfade («Audiodatei nicht
 * gefunden: /Users/<name>/.therascript/…») — auch in der gepackten App, etwa
 * wenn eine Aufnahme- oder Modelldatei fehlt. Solche Pfade verraten den
 * Benutzernamen und helfen Nutzer:innen nicht: Sie gehören ins Log, nicht auf
 * die Karte. Diese Funktion entfernt sie aus dem sichtbaren Text; der Aufrufer
 * loggt die vollständige Meldung.
 */

// Ein Pfad beginnt am Textanfang oder nach Leerraum/Klammer/Anführungszeichen
// mit «/» oder «~/», enthält mindestens einen weiteren «/» und endet vor
// Leerraum, schliessender Klammer oder einem Satzzeichen am Wortende.
const ABSOLUTE_PATH = /(^|[\s(«"'])((?:~|\/)[^\s«»"')]*\/[^\s«»"')]*?)([.,;:!?]*)(?=$|[\s)»"'])/g

export function stripAbsolutePaths(message: string): string {
  return message
    .replace(ABSOLUTE_PATH, (_match, before: string, _path: string, punct: string) => {
      return `${before}${punct}`
    })
    .replace(/:\s*([.,;!?])/g, '$1')
    .replace(/\(\s*\)/g, '')
    .replace(/\s+([.,;!?])/g, '$1')
    .replace(/[\s:]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}
