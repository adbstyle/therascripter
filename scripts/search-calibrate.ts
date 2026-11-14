/**
 * Kalibrierung der Schwelle «ausreichend passend» der Suche nach Bedeutung
 * (#209 AK 6, PR S6) aus den Messdaten des Abnahmetests.
 *
 *   npm run test:search-quality   # schreibt die Messdaten, Pfad in der Ausgabe
 *                                 # (fester Pfad: THERASCRIPT_SEARCH_QUALITY_OUT)
 *   npx tsx scripts/search-calibrate.ts <reference-run.json> [--from 0.60] [--to 0.80] [--step 0.01]
 *
 * Gibt für jede Schwelle T aus — für die Suche nach Bedeutung allein und für
 * die Produktiv-Rangfolge (exakte Treffer zuerst, gruppiert mit bis zu drei
 * Fundstellen pro Dokument, `rankDocuments`):
 * - Anteil der Anfragen mit Treffern, die mindestens einen relevanten Treffer zeigen,
 * - Anteil der Anfragen ohne Treffer (Typ `negativ`), die nichts zeigen,
 * - Recall der Abschnitte mit Note 2,
 * - angezeigte Sitzungen/PDF-Dokumente pro Anfrage (mit / ohne Treffer),
 * dazu nDCG@10 der Produktiv-Rangfolge mit 95 %-CI.
 *
 * Das Referenz-Set ist klein (148 Abschnitte, 10 Anfragen ohne Treffer): bei
 * grossen Beständen steigen die Spitzenwerte unpassender Abschnitte. Die
 * Wahl trifft der Product Owner (docs/product/features/search.md).
 */
import { readFileSync } from 'fs'
import {
  DEFAULT_REFERENCE_DIR,
  calibrate,
  calibrationTable,
  evaluateRun,
  loadQrels,
  type ReferenceRun
} from '../src/main/search/__tests__/referenceSet'

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback
}

const file = process.argv[2]
if (!file || file.startsWith('--')) {
  console.error(
    'Aufruf: npx tsx scripts/search-calibrate.ts <reference-run.json> [--from] [--to] [--step]'
  )
  process.exit(1)
}
const run = JSON.parse(readFileSync(file, 'utf-8')) as ReferenceRun
const qrels = loadQrels(process.env.THERASCRIPT_SEARCH_REFERENCE_DIR ?? DEFAULT_REFERENCE_DIR)
const from = arg('from', 0.6)
const to = arg('to', 0.8)
const step = arg('step', 0.01)
const thresholds: number[] = []
for (let k = 0; from + k * step <= to + 1e-9; k++)
  thresholds.push(Math.round((from + k * step) * 1000) / 1000)

console.log(calibrationTable(calibrate(run, qrels, thresholds)))
console.log('')
console.log('| T | nDCG@10 Produktiv (95 %-CI) | Hit@5 Produktiv |')
console.log('|---|---|---|')
for (const t of thresholds) {
  const p = evaluateRun(run, qrels, t).production
  console.log(
    `| ${t.toFixed(2)} | ${p.ndcg10.toFixed(3)} (${p.ci95[0].toFixed(3)}–${p.ci95[1].toFixed(3)}) | ${p.hit5.toFixed(2)} |`
  )
}
const s = evaluateRun(run, qrels, thresholds[0]).semantic
console.log('')
console.log(
  `Vor der Schwelle (AK 13): nDCG@10 ${s.ndcg10.toFixed(3)} (95 %-CI ${s.ci95[0].toFixed(3)}–${s.ci95[1].toFixed(3)}), Neg-AUC ${s.negAuc?.toFixed(3)}`
)
