import { describe, it, expect } from 'vitest'
import { stripAbsolutePaths } from '../userFacingError'

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
      'Fehler beim Lesen von «» (Exit 1)'
    ],
    ['Zeitüberschreitung nach 900s', 'Zeitüberschreitung nach 900s'],
    ['Verarbeitung reagiert nicht mehr', 'Verarbeitung reagiert nicht mehr'],
    ['Seite 1/2 nicht lesbar', 'Seite 1/2 nicht lesbar']
  ])('%s', (input, expected) => {
    expect(stripAbsolutePaths(input)).toBe(expected)
  })

  it('lässt keinen Benutzernamen aus einem Pfad stehen', () => {
    const out = stripAbsolutePaths(
      'NER fehlgeschlagen in /Users/max.muster/.therascript/models/ner/x.pt: Speicher voll'
    )
    expect(out).not.toContain('max.muster')
    expect(out).not.toContain('/')
  })
})
