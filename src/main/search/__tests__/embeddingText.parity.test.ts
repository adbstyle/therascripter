import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { buildSearchSections, sectionEmbeddingText, sectionIndexText } from '../chunker'
import { readFixtureDocs } from './chunker-fixture-docs'

// Was das Suchmodell pro Abschnitt sieht, muss dem Spike entsprechen, auf dem
// der Zielwert der Trefferqualität gemessen wurde (#209 AK 13):
// search-spike.py `build_chunks` → "\n".join(f"{speaker}: {text}") über die
// Units des Abschnitts, eingebettet mit dem Dokument-Prompt (setzt der
// Suchdienst davor). Der Trigramm-Index sieht dagegen nur die Unit-Texte.

interface FixtureUnit {
  id: string
  speaker: string
  text?: string
}
interface FixtureDocEntry {
  units: FixtureUnit[]
  chunks: Array<{ units: string[] }>
}

const FIXTURES = join(__dirname, 'fixtures')
const fixture = JSON.parse(readFileSync(join(FIXTURES, 'chunker-parity.json'), 'utf-8')) as {
  own: Record<string, FixtureDocEntry>
}

describe('embedding text — parity with search-spike.py', () => {
  for (const doc of readFixtureDocs(join(FIXTURES, 'chunker-docs'))) {
    it(`gives the model the spike's chunk text for ${doc.id}`, () => {
      const expected = fixture.own[doc.id]
      const unitText = new Map(expected.units.map((u) => [u.id, `${u.speaker}: ${u.text}`]))
      // Die eigenen Fixture-Dokumente tragen den Klartext jeder Unit
      expect(expected.units.every((u) => u.text !== undefined)).toBe(true)
      const spikeTexts = expected.chunks.map((c) =>
        c.units.map((id) => unitText.get(id)).join('\n')
      )

      const body = buildSearchSections({
        type: doc.type,
        title: '',
        summary: null,
        document: doc.document
      }).filter((s) => s.field === 'body')
      expect(body.map((s) => sectionEmbeddingText(s))).toEqual(spikeTexts)
      // Der Index lässt die Präfixe weg — das Modell nicht
      expect(body.every((s) => !/^(Sprecher \d+|Bericht): /.test(sectionIndexText(s)))).toBe(true)
    })
  }
})
