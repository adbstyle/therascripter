import { describe, it, expect } from 'vitest'
import { stripAbsolutePaths } from '../userFacingError'

const ROOTS = ['/Users/anna', '/Users/max muster']

describe('stripAbsolutePaths (Fehlermeldungen auf Sitzungskarten)', () => {
  it.each([
    [
      'whisper-cli binary nicht gefunden: /Users/anna/Dev/app/resources/whisper/bin/whisper-cli. Bitte prüfen Sie die Installation.',
      'whisper-cli binary nicht gefunden. Bitte prüfen Sie die Installation.'
    ],
    [
      'Audiodatei nicht gefunden: /Users/anna/.therascript/audio/abc.wav',
      'Audiodatei nicht gefunden'
    ],
    ['PDF nicht gefunden: ~/Library/x/y.pdf', 'PDF nicht gefunden'],
    [
      'Fehler beim Lesen von «/private/var/folders/x/y.json» (Exit 1)',
      'Fehler beim Lesen von (Exit 1)'
    ],
    [
      'Einstellungen nicht lesbar: /Users/anna/Library/Application Support/Therascript/settings.json. Bitte neu starten.',
      'Einstellungen nicht lesbar. Bitte neu starten.'
    ],
    [
      'Modell fehlt (/Volumes/Macintosh HD/Users/anna/.therascript/models/asr/x.bin)',
      'Modell fehlt'
    ],
    ['Datei "/Users/max muster/.therascript/pdf/a b.pdf" fehlt', 'Datei fehlt'],
    ["Pfad '/Users/anna/x/y' ungültig", 'Pfad ungültig'],
    ['Ziel=/Users/anna/.therascript/data/x.db', 'Ziel'],
    ['Datei [/opt/homebrew/lib/libggml.dylib] fehlt', 'Datei fehlt'],
    ['Zeitüberschreitung nach 900s', 'Zeitüberschreitung nach 900s'],
    ['Verarbeitung reagiert nicht mehr', 'Verarbeitung reagiert nicht mehr'],
    ['Seite 1/2 nicht lesbar', 'Seite 1/2 nicht lesbar'],
    ['Termin und/oder Ort am 12/2026 fehlt', 'Termin und/oder Ort am 12/2026 fehlt'],
    [
      'Siehe https://example.com/hilfe/a für Details',
      'Siehe https://example.com/hilfe/a für Details'
    ]
  ])('%s', (input, expected) => {
    expect(stripAbsolutePaths(input, ROOTS)).toBe(expected)
  })

  it('lässt keinen Benutzernamen und keinen Pfadrest stehen', () => {
    for (const message of [
      'NER fehlgeschlagen in /Users/max.muster/.therascript/models/ner/x.pt: Speicher voll',
      'Fehler: /Users/max muster/Library/Application Support/Therascript/db/x: kaputt',
      'Kein Zugriff auf /Volumes/Macintosh HD/Users/max muster/Documents/a.wav'
    ]) {
      const out = stripAbsolutePaths(message, ['/Users/max muster'])
      expect(out).not.toMatch(/max|muster|Application|Support|Macintosh|Volumes|Users|\//)
    }
  })

  it('ersetzt das Home-Verzeichnis auch ohne ausdrückliche Wurzeln (Standard: os.homedir)', () => {
    const out = stripAbsolutePaths('Fehlt: /Users/someone/.therascript/x.wav')
    expect(out).toBe('Fehlt')
  })
})
