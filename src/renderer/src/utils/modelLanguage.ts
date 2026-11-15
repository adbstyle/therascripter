/**
 * Sprach-Badge einer Modellkarte: ausgeschriebene Sprache statt Kürzel
 * (Sichtprüfung: «en» stand roh neben «Hochdeutsch»). Unbekannte Kürzel
 * bleiben, wie sie sind.
 */
export function formatModelLanguage(code: string): string {
  switch (code) {
    case 'multi':
      return 'Multilingual'
    case 'de':
      return 'Hochdeutsch'
    case 'en':
      return 'Englisch'
    default:
      return code
  }
}
