import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

// Die Packfunktion lebt im Python-Sidecar (python_sidecar/ner_service.py), weil dort
// der Forward-Pass gebaut wird. Getestet wird sie von hier aus, damit die Regel
// "Batch-Grösse in Token-Slots, nicht in Segmenten" im normalen `npm test`-Lauf
// abgesichert ist. Der Aufruf braucht KEIN venv: die Top-Level-Imports von
// ner_service.py sind reine stdlib, flair wird erst in run_ner importiert.
const repoRoot = join(__dirname, '..', '..', '..', '..')
const sidecarDir = join(repoRoot, 'python_sidecar')

const PY_PROGRAM = `
import json
import sys

sys.path.insert(0, sys.argv[1])

from ner_service import (
    pack_by_budget,
    estimate_item,
    TOKEN_BUDGET,
    MAX_SENTENCES_PER_BATCH,
    MIN_TOKEN_BUDGET
)

payload = json.loads(sys.argv[2])
items = [tuple(item) for item in payload['items']]
groups = pack_by_budget(items, **payload.get('kwargs', {}))

print(json.dumps({
    'groups': groups,
    'estimates': [estimate_item('x' * n) for n in payload.get('charLengths', [])],
    'tokenBudget': TOKEN_BUDGET,
    'maxSentences': MAX_SENTENCES_PER_BATCH,
    'minTokenBudget': MIN_TOKEN_BUDGET
}))
`

/** Ein Item: [rows, row_len] — rows = Anzahl 512-Token-Fenster, row_len = Fensterlänge. */
type PackItem = [number, number]

interface PackResult {
  groups: number[][]
  estimates: PackItem[]
  tokenBudget: number
  maxSentences: number
  minTokenBudget: number
}

function runSidecar(
  items: PackItem[],
  opts: { tokenBudget?: number; maxSentences?: number; charLengths?: number[] } = {}
): PackResult {
  const kwargs: Record<string, number> = {}
  if (opts.tokenBudget !== undefined) kwargs.token_budget = opts.tokenBudget
  if (opts.maxSentences !== undefined) kwargs.max_sentences = opts.maxSentences
  const payload = JSON.stringify({ items, kwargs, charLengths: opts.charLengths ?? [] })
  const stdout = execFileSync('python3', ['-c', PY_PROGRAM, sidecarDir, payload], {
    encoding: 'utf-8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
  })
  return JSON.parse(stdout) as PackResult
}

function hasPython3(): boolean {
  try {
    execFileSync('python3', ['-c', 'pass'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function slotsOf(items: PackItem[], group: number[]): number {
  const rows = group.reduce((sum, index) => sum + items[index][0], 0)
  const maxLen = Math.max(...group.map((index) => items[index][1]))
  return rows * maxLen
}

function repeat(item: PackItem, count: number): PackItem[] {
  return Array.from({ length: count }, () => [...item] as PackItem)
}

// Ohne python3 (z. B. minimaler CI-Container) darf die Suite nicht rot werden.
const describeIfPython3 = hasPython3() ? describe : describe.skip

describeIfPython3('pack_by_budget (python_sidecar/ner_service.py)', () => {
  it('exposes the budget constants the OOM fix depends on', () => {
    // 4096 Slots ⇒ max 8 × 512-Token-Zeilen pro Forward-Pass ⇒ ~5.32 GiB statt
    // der gemessenen 14.07 GiB (Ceiling auf 8-GB-Macs: 9.07 GiB).
    const result = runSidecar([[1, 64]])
    expect(result.tokenBudget).toBe(4096)
    expect(result.maxSentences).toBe(32)
    // Boden der adaptiven Halbierung: 512 = genau eine 512-Token-Zeile.
    expect(result.minTokenBudget).toBe(512)
  })

  it('caps page-sized PDF segments at the token budget instead of at 32 segments', () => {
    // Der ursprüngliche Bug: BATCH_SIZE = 32 packte 32 seitengrosse Segmente
    // (2–3 Fenster à 512 Tokens) in EINEN Forward-Pass.
    const items: PackItem[] = [...repeat([2, 512], 11), ...repeat([3, 512], 11)]
    const { groups } = runSidecar(items)

    // Nachgerechnet: (2+2)*512 = 2048, +2 ⇒ 3072, +2 ⇒ 4096 (passt exakt),
    // +2 ⇒ 5120 > 4096 ⇒ Schnitt. Also 4 Items pro Gruppe bei (2, 512).
    // Bei (3, 512): 3*512 = 1536, +3 ⇒ 3072, +3 ⇒ 4608 > 4096 ⇒ 2 Items pro Gruppe.
    expect(groups).toEqual([
      [0, 1, 2, 3],
      [4, 5, 6, 7],
      [8, 9, 10],
      [11, 12],
      [13, 14],
      [15, 16],
      [17, 18],
      [19, 20],
      [21]
    ])
  })

  it('still groups short audio segments into batches of 32', () => {
    // Speedup aus Commit ad9c716: ~64-Token-Segmente (1 Zeile) dürfen nicht
    // einzeln durch den Tagger — hier greift max_sentences, nicht das Budget
    // (64 Zeilen à 64 Tokens wären erst bei 4096 Slots voll).
    const items = repeat([1, 64], 64)
    const { groups } = runSidecar(items)

    expect(groups.length).toBe(2)
    expect(groups[0].length).toBe(32)
    expect(groups[1].length).toBe(32)
    expect(groups[0]).toEqual(Array.from({ length: 32 }, (_, i) => i))
    expect(groups[1]).toEqual(Array.from({ length: 32 }, (_, i) => i + 32))
  })

  it('puts an oversized single segment into its own group without dropping neighbours', () => {
    // 20 × 512 = 10240 Slots — über Budget. Ein solches Segment MUSS trotzdem
    // durchlaufen (sonst geht Text verloren), aber allein.
    const items: PackItem[] = [
      [1, 64],
      [1, 64],
      [20, 512],
      [1, 64],
      [1, 64]
    ]
    const { groups } = runSidecar(items)

    expect(groups).toEqual([[0, 1], [2], [3, 4]])
    expect(slotsOf(items, [2])).toBeGreaterThan(4096)
  })

  it('returns no groups for an empty item list', () => {
    expect(runSidecar([]).groups).toEqual([])
  })

  it('never exceeds the budget for multi-item groups in a mixed workload', () => {
    // Gemischt: kurze Audio-artige und lange PDF-artige Segmente durcheinander.
    // Property: nur Gruppen mit genau einem Item dürfen das Budget reissen.
    const rowsCycle = [1, 2, 1, 3, 1, 8]
    const lenCycle = [64, 512, 128, 512, 256, 512]
    const items: PackItem[] = Array.from(
      { length: 60 },
      (_, i) => [rowsCycle[i % rowsCycle.length], lenCycle[i % lenCycle.length]] as PackItem
    )
    const { groups } = runSidecar(items)

    expect(groups.flat()).toEqual(Array.from({ length: items.length }, (_, i) => i))
    for (const group of groups) {
      expect(group.length).toBeGreaterThan(0)
      expect(group.length).toBeLessThanOrEqual(32)
      if (group.length > 1) {
        expect(slotsOf(items, group)).toBeLessThanOrEqual(4096)
      }
    }
  })

  it('honours explicit token_budget and max_sentences overrides', () => {
    const items = repeat([1, 128], 10)

    // Budget 512 ⇒ 4 Zeilen à 128 Tokens pro Gruppe.
    expect(runSidecar(items, { tokenBudget: 512 }).groups).toEqual([
      [0, 1, 2, 3],
      [4, 5, 6, 7],
      [8, 9]
    ])

    // max_sentences 3 schneidet vor dem Budget.
    expect(runSidecar(items, { maxSentences: 3 }).groups).toEqual([
      [0, 1, 2],
      [3, 4, 5],
      [6, 7, 8],
      [9]
    ])
  })

  it('estimates rows above the real tokenizer count, never below', () => {
    // Fallback, wenn flairs Tokenizer-Interna nicht erreichbar sind. Er MUSS
    // überschätzen: die alte Konstante (1, 512) zählte jede PDF-Seite als eine
    // Zeile statt als 2–3 und hätte das gefixte OOM reproduziert.
    // Referenzwerte real gemessen (deutscher Fliesstext, XLM-R):
    // 220 Z. → (1, 57), 2800 Z. → (2, 512), 3800 Z. → (3, 512).
    const { estimates } = runSidecar([[1, 64]], { charLengths: [220, 2800, 3800] })
    const real: PackItem[] = [
      [1, 57],
      [2, 512],
      [3, 512]
    ]
    estimates.forEach(([rows, rowLen], i) => {
      expect(rows).toBeGreaterThanOrEqual(real[i][0])
      expect(rowLen).toBeGreaterThanOrEqual(real[i][1])
    })
    // Konkret: seitengrosse Segmente landen bei 3 bzw. 4 Zeilen.
    expect(estimates).toEqual([
      [1, 73],
      [3, 512],
      [4, 512]
    ])
  })
})
