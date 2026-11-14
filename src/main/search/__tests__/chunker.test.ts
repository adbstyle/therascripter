import { describe, it, expect } from 'vitest'
import {
  buildSearchSections,
  buildUnits,
  paragraphSearchText,
  sectionIndexText,
  splitTurn,
  unitTextSpans
} from '../chunker'
import { makeDoc } from './helpers'

describe('search chunker', () => {
  it('counts chips with their original, without one with their token, and skips speaker/time nodes', () => {
    const doc = makeDoc([
      {
        speaker: 'A',
        timestamp: '00:00:05',
        text: 'Ich war mit {{Lina Huber|PERSON|1}} in {{|ORT|2}}.'
      }
    ])
    const para = paragraphSearchText(doc.content[0])
    expect(para.text).toBe('  Ich war mit Lina Huber in [ORT 2].')
    expect(para.speakerLabel).toBe('Person A')
    expect(para.timestamp).toBe('00:00:05')
  })

  it('numbers speakers by first appearance and prefixes PDFs with «Bericht»', () => {
    const audio = buildUnits(
      makeDoc([
        { speaker: 'B', text: 'Erster Beitrag.' },
        { speaker: 'A', text: 'Zweiter Beitrag.' },
        { speaker: 'B', text: 'Dritter Beitrag.' }
      ]),
      'audio'
    )
    expect(audio.map((u) => u.speaker)).toEqual(['Sprecher 1', 'Sprecher 2', 'Sprecher 1'])
    expect(audio.map((u) => u.spk)).toEqual(['Person B', 'Person A', 'Person B'])
    const pdf = buildUnits(makeDoc([{ text: 'Seite eins.' }, { text: '   ' }]), 'pdf')
    expect(pdf).toHaveLength(1)
    expect(pdf[0].speaker).toBe('Bericht')
  })

  it('keeps [s, e) exact on the paragraph text, also for split units', () => {
    const sentence = 'Das ist ein Satz mit genau zehn Wörtern hier drin. '
    const text = sentence.repeat(30).trim()
    const doc = makeDoc([{ speaker: 'A', text }])
    const para = paragraphSearchText(doc.content[0]).text
    const units = buildUnits(doc, 'audio')
    expect(units.length).toBeGreaterThan(1)
    for (const u of units) {
      expect(para.slice(u.s, u.e)).toBe(u.text)
      expect(u.words).toBeLessThanOrEqual(120)
    }
  })

  it('splits a sentence without punctuation at word boundaries', () => {
    const text = Array.from({ length: 250 }, (_, i) => `w${i}`).join(' ')
    const pieces = splitTurn(text)
    expect(pieces.map(([s, e]) => text.slice(s, e).split(' ').length)).toEqual([120, 120, 10])
  })

  it('builds title, summary and body sections with unit positions', () => {
    const sections = buildSearchSections({
      type: 'audio',
      title: '  Erstgespräch Lina  ',
      summary: 'Kurz zusammengefasst.',
      document: makeDoc([
        { speaker: 'A', timestamp: '00:00:01', text: 'Guten Tag.' },
        { speaker: 'B', text: 'Hallo {{Lina|PERSON|1}}.' }
      ])
    })
    expect(sections.map((s) => s.field)).toEqual(['title', 'summary', 'body'])
    expect(sections[0].text).toBe('Erstgespräch Lina')
    const body = sections[2]
    expect(body.text).toBe('Sprecher 1: Guten Tag.\nSprecher 2: Hallo Lina.')
    expect(body.paraFrom).toBe(0)
    expect(body.paraTo).toBe(1)
    expect(body.units[0]).toMatchObject({ p: 0, o: 0, pfx: 12, spk: 'Person A', ts: '00:00:01' })
    const spans = unitTextSpans(body).map(({ start, end }) => body.text.slice(start, end))
    expect(spans).toEqual(['Guten Tag.', 'Hallo Lina.'])
    // Der Index sieht keine Präfixe — «sprecher» träfe sonst jeden Abschnitt
    expect(sectionIndexText(body)).toBe('Guten Tag.\nHallo Lina.')
  })

  it('omits empty title and summary and tolerates a broken document', () => {
    expect(buildSearchSections({ type: 'pdf', title: ' ', summary: null, document: null })).toEqual(
      []
    )
    expect(
      buildSearchSections({ type: 'pdf', title: 'T', summary: '', document: { content: 'kaputt' } })
    ).toHaveLength(1)
  })
})
