import { describe, it, expect } from 'vitest'
import { filterDossiers, prepareDossierFilter } from '../dossierFilter'
import type { DossierListItem } from '../../../../shared/types/Dossier'

function item(id: string, firstName: string, lastName: string): DossierListItem {
  return {
    id,
    firstName,
    lastName,
    externalId: null,
    birthDate: null,
    entryCount: 0,
    lastEntryDay: null
  }
}

const LIST = [
  item('1', 'Lea', 'Bachmann'),
  item('2', 'Lukas', 'Hofer'),
  item('3', 'Anna', 'Meier'),
  item('4', 'Jürg', 'Müller'),
  item('5', 'Annemarie', 'Studer')
]

const ids = (query: string): string[] =>
  filterDossiers(prepareDossierFilter(LIST), query).map((d) => d.id)

describe('filterDossiers (#204 AK 14)', () => {
  it('zeigt ohne Filter alle in der gelieferten Reihenfolge', () => {
    expect(ids('')).toEqual(['1', '2', '3', '4', '5'])
    expect(ids('   ')).toEqual(['1', '2', '3', '4', '5'])
  })

  it('findet Teile von Vor- oder Nachnamen', () => {
    expect(ids('hof')).toEqual(['2'])
    expect(ids('ann')).toEqual(['1', '3', '5'])
  })

  it('verlangt jeden Suchteil in Vor- oder Nachnamen («ann mei»)', () => {
    expect(ids('ann mei')).toEqual(['3'])
    expect(ids('mei ann')).toEqual(['3'])
    expect(ids('Lukas Hofer')).toEqual(['2'])
    expect(ids('lukas meier')).toEqual([])
  })

  it('normalisiert wie normalizeDossierKey: Gross-/Kleinschreibung, Umlaute, NFD', () => {
    expect(ids('MUELLER')).toEqual(['4'])
    expect(ids('müll')).toEqual(['4'])
    expect(ids('müller')).toEqual(['4'])
    expect(ids('juerg')).toEqual(['4'])
  })

  it('filtert 500 Dossiers ohne spürbare Verzögerung (AK 15)', () => {
    const many = Array.from({ length: 500 }, (_, i) =>
      item(`d${i}`, `Vorname${i}`, `Nachname${String(i).padStart(3, '0')}`)
    )
    const start = performance.now()
    const prepared = prepareDossierFilter(many)
    for (const q of ['n', 'na', 'nac', 'nach', 'nachname4', 'nachname42', 'vorn 42']) {
      filterDossiers(prepared, q)
    }
    const elapsed = performance.now() - start
    expect(filterDossiers(prepared, 'nachname42').map((d) => d.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `d${420 + i}`)
    )
    // Grosszügig, damit langsame CI-Maschinen nicht flackern; real < 10 ms
    expect(elapsed).toBeLessThan(100)
  })
})
