import { normalizeSearchText } from '../../../shared/utils/search-normalize'
import type { SearchModelInfo } from '../searchModel'

/**
 * Deterministischer Ersatz für das Suchmodell in Unit-Tests: Wort-Hashing in
 * 768 Dimensionen, L2-normalisiert. Texte mit gemeinsamen Wörtern haben einen
 * hohen Kosinus — genug, um Ranking, Schwelle und Vektorphase ohne Python zu
 * prüfen.
 */

export const TEST_MODEL: SearchModelInfo = {
  dir: '/nicht/benutzt',
  modelId: 'test-model',
  dim: 768,
  queryPrompt: '',
  documentPrompt: '',
  maxTokens: 1024,
  padMultiple: 128
}

function hash(word: string): number {
  let h = 2166136261
  for (const ch of word) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619) >>> 0
  return h
}

export function fakeEmbed(text: string, dim = 768): Float32Array {
  const v = new Float32Array(dim)
  const words = normalizeSearchText(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !w.startsWith('sprecher'))
  for (const w of words) {
    const h = hash(w)
    v[h % dim] += 1
    v[(h >>> 10) % dim] += 0.5
  }
  let n = 0
  for (const x of v) n += x * x
  n = Math.sqrt(n)
  if (n > 0) for (let i = 0; i < dim; i++) v[i] /= n
  else v[0] = 1
  return v
}
