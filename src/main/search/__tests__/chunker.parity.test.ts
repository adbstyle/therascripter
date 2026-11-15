import { describe, it, expect } from 'vitest'
import { createHash } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { buildChunks, buildUnits, type SearchUnit } from '../chunker'
import { readFixtureDocs } from './chunker-fixture-docs'
import {
  SEARCH_MAX_OVERLAP_WORDS,
  SEARCH_MAX_UNIT_WORDS,
  SEARCH_TARGET_WORDS
} from '../../../shared/search-config'

// Parität des TS-Chunkers mit `scripts/search-spike.py` (Spike #208), auf dem
// der Zielwert der Trefferqualität gemessen wurde (#209 AK 13). Die Fixture
// erzeugt `scripts/search-chunker-fixture.py` mit den Original-Funktionen des
// Spikes (Anleitung im Kopf des Skripts).

interface FixtureUnit {
  id: string
  speaker: string
  words: number
  text?: string
  sha1?: string
}
interface FixtureDocEntry {
  kind: 'session' | 'report'
  units: FixtureUnit[]
  chunks: Array<{ id: string; units: string[]; words: number }>
}
interface Fixture {
  constants: { TARGET_WORDS: number; MAX_UNIT_WORDS: number; MAX_OVERLAP_WORDS: number }
  own: Record<string, FixtureDocEntry>
  reference?: Record<string, FixtureDocEntry>
}

const FIXTURES = join(__dirname, 'fixtures')
const fixture = JSON.parse(readFileSync(join(FIXTURES, 'chunker-parity.json'), 'utf-8')) as Fixture

// Das Referenz-Set kommt mit PR #214 ins Repo; bis dahin lässt es sich über
// die Variable auf einen anderen Checkout zeigen.
const REFERENCE_DIR =
  process.env.THERASCRIPT_SEARCH_REFERENCE_DIR ??
  join(__dirname, '..', '..', '..', '..', 'tests', 'fixtures', 'search-reference')

/** Unit-ID wie im Spike: `<doc>:<beitrag>.<teil>`. */
function unitIds(doc: string, units: SearchUnit[]): string[] {
  const pieceOf = new Map<number, number>()
  return units.map((u) => {
    const piece = pieceOf.get(u.p) ?? 0
    pieceOf.set(u.p, piece + 1)
    return `${doc}:${String(u.p).padStart(3, '0')}.${piece}`
  })
}

function compareDoc(
  doc: string,
  type: 'audio' | 'pdf',
  document: unknown,
  expected: FixtureDocEntry
): void {
  expect(type).toBe(expected.kind === 'report' ? 'pdf' : 'audio')
  const units = buildUnits(document, type)
  const ids = unitIds(doc, units)
  expect(ids).toEqual(expected.units.map((u) => u.id))
  units.forEach((unit, i) => {
    const want = expected.units[i]
    expect(unit.speaker, ids[i]).toBe(want.speaker)
    expect(unit.words, ids[i]).toBe(want.words)
    if (want.text !== undefined) expect(unit.text, ids[i]).toBe(want.text)
    if (want.sha1 !== undefined) {
      const sha1 = createHash('sha1').update(unit.text, 'utf8').digest('hex').slice(0, 12)
      expect(sha1, ids[i]).toBe(want.sha1)
    }
  })
  const idOf = new Map(units.map((u, i) => [u, ids[i]]))
  const chunks = buildChunks(units)
  expect(chunks.map((c) => c.units.map((u) => idOf.get(u)))).toEqual(
    expected.chunks.map((c) => c.units)
  )
  expect(chunks.map((c) => c.words)).toEqual(expected.chunks.map((c) => c.words))
}

describe('search chunker — parity with search-spike.py', () => {
  it('uses the constants of the spike', () => {
    expect(fixture.constants).toEqual({
      TARGET_WORDS: SEARCH_TARGET_WORDS,
      MAX_UNIT_WORDS: SEARCH_MAX_UNIT_WORDS,
      MAX_OVERLAP_WORDS: SEARCH_MAX_OVERLAP_WORDS
    })
  })

  const own = readFixtureDocs(join(FIXTURES, 'chunker-docs'))

  it('covers long turns, sentence and word splits, overlap and a report', () => {
    expect(own.map((d) => d.id)).toEqual(Object.keys(fixture.own))
    const all = Object.values(fixture.own)
    expect(all.some((d) => d.units.some((u) => u.id.endsWith('.1')))).toBe(true)
    expect(all.some((d) => d.chunks.length > 1)).toBe(true)
    expect(all.some((d) => d.kind === 'report')).toBe(true)
  })

  for (const doc of own) {
    it(`builds the same units and sections for ${doc.id}`, () => {
      compareDoc(doc.id, doc.type, doc.document, fixture.own[doc.id])
    })
  }

  const hasReference = fixture.reference !== undefined && existsSync(REFERENCE_DIR)
  it.skipIf(!hasReference)('builds the same units and sections for the reference set', () => {
    const docs = readFixtureDocs(REFERENCE_DIR)
    expect(docs.map((d) => d.id).sort()).toEqual(Object.keys(fixture.reference!).sort())
    for (const doc of docs) compareDoc(doc.id, doc.type, doc.document, fixture.reference![doc.id])
  })
})
