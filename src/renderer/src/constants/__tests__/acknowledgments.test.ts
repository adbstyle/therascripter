import { describe, it, expect } from 'vitest'
import { MODEL_DEFINITIONS } from '../../../../shared/model-catalog'
import { MODEL_ACKNOWLEDGMENTS, SOFTWARE_ACKNOWLEDGMENTS } from '../acknowledgments'

const all = [...SOFTWARE_ACKNOWLEDGMENTS, ...MODEL_ACKNOWLEDGMENTS]

describe('acknowledgments', () => {
  it('covers every model the catalog distributes', () => {
    const covered = new Set(MODEL_ACKNOWLEDGMENTS.flatMap((a) => a.catalogIds ?? []))
    for (const m of MODEL_DEFINITIONS) expect(covered, m.id).toContain(m.id)
  })

  it('has no entry for a model the catalog no longer distributes', () => {
    const catalog = new Set(MODEL_DEFINITIONS.map((m) => m.id))
    for (const id of MODEL_ACKNOWLEDGMENTS.flatMap((a) => a.catalogIds ?? [])) {
      expect(catalog, id).toContain(id)
    }
  })

  it('ships the full license text with copyright for every MIT and Apache entry', () => {
    for (const a of all.filter((x) => x.license === 'MIT')) {
      expect(a.notice, a.name).toMatch(/Copyright/)
      expect(a.notice, a.name).toMatch(/Permission is hereby granted/)
    }
    for (const a of all.filter((x) => x.license.startsWith('Apache'))) {
      expect(a.notice, a.name).toMatch(/Apache License/)
      expect(a.notice, a.name).toMatch(/END OF TERMS AND CONDITIONS/)
    }
  })

  it('links the Creative Commons license for every CC entry', () => {
    for (const a of all.filter((x) => x.license.startsWith('CC'))) {
      expect(a.notice, a.name).toMatch(/https:\/\/creativecommons\.org\/licenses\//)
    }
  })
})
