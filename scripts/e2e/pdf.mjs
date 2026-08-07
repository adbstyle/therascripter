#!/usr/bin/env node
/**
 * PDF-E2E gegen die ECHTE (gepackte) App: Import → Extraktion → NER →
 * Hintergrund-Summary → review — über dieselbe Renderer-API (window.api.*),
 * die ein User-Klick benutzt. Räumt die Test-Session am Ende über den
 * regulären Delete-Pfad wieder weg.
 *
 * Vorbereitung:
 *   dist/mac-arm64/Therascript.app/Contents/MacOS/Therascript --remote-debugging-port=9223 &
 * Usage:
 *   node scripts/e2e/pdf.mjs <pfad/zur/test.pdf> [erwartetes-textfragment]
 *
 * Entstanden nach dem DOMMatrix-Bundle-Bug: Unit-Tests, Lint, Typecheck und
 * Startup-Smoke waren alle grün, während der PDF-Import im DMG tot war.
 * Dieser Test fährt den Feature-Pfad wirklich.
 */
import { evalInApp, closeCdp } from './cdp.mjs'

const PDF_PATH = process.argv[2]
const NEEDLE = process.argv[3] ?? null
if (!PDF_PATH) {
  console.error('Usage: node scripts/e2e/pdf.mjs <pfad/zur/test.pdf> [textfragment]')
  process.exit(1)
}

const started = Date.now()
const log = (m) => console.log(`[${((Date.now() - started) / 1000).toFixed(0)}s] ${m}`)
let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

/** Nur sichtbare Textknoten — Chip-Attribute tragen designbedingt das Original. */
function visibleText(node, out = []) {
  if (node.type === 'text') out.push(node.text)
  for (const c of node.content ?? []) visibleText(c, out)
  return out
}

log('Import anstoßen (window.api.import.pdf) …')
const sessions = await evalInApp(`window.api.import.pdf(${JSON.stringify([PDF_PATH])})`)
check('Import liefert genau 1 Session', sessions?.length === 1)
const sessionId = sessions[0].id
log(`Session ${sessionId} — Status: ${sessions[0].status}`)

let session
let lastStatus = ''
const deadline = Date.now() + 600_000
while (Date.now() < deadline) {
  const list = await evalInApp('window.api.sessions.list()')
  session = list.find((s) => s.id === sessionId)
  if (!session) break
  if (session.status !== lastStatus) {
    lastStatus = session.status
    log(`Status: ${session.status}`)
  }
  if (session.status === 'review' || session.status === 'error') break
  await new Promise((r) => setTimeout(r, 3000))
}

check('Session erreicht review (nicht error)', session?.status === 'review', session?.errorMessage ?? '')
if (session?.status !== 'review') {
  console.log(`\nSession ${sessionId} bleibt zur Diagnose erhalten.`)
  closeCdp()
  process.exit(1)
}

check('wordCount > 0', (session.wordCount ?? 0) > 0, `wordCount=${session.wordCount}`)
check(
  'anonymizationCount gesetzt',
  typeof session.anonymizationCount === 'number',
  `count=${session.anonymizationCount}`
)

const review = await evalInApp(`window.api.review.load(${JSON.stringify(sessionId)})`)
const text = visibleText(review.document).join(' ')
check('Dokument hat sichtbaren Text', text.trim().length > 100, `${text.length} Zeichen`)
if (NEEDLE) {
  check(`Erwartetes Fragment "${NEEDLE}" im Text`, text.includes(NEEDLE))
}
check('sessionType=pdf, reviewAt gesetzt', review.sessionType === 'pdf' && !!review.reviewAt)

// Review-Ungating: Summary kommt im Hintergrund nach review an
log('Auf Hintergrund-Summary warten (llama; Graceful-Skip zulässig, wenn Modell fehlt) …')
let summary = null
const sumDeadline = Date.now() + 180_000
while (Date.now() < sumDeadline) {
  summary = await evalInApp(`window.api.summary.get(${JSON.stringify(sessionId)})`)
  if (summary?.text) break
  await new Promise((r) => setTimeout(r, 5000))
}
log(summary?.text ? `Summary: "${summary.text.slice(0, 70)}…"` : 'Keine Summary (Skip-Pfad)')

log('Aufräumen über den regulären Delete-Pfad …')
const deleted = await evalInApp(`window.api.sessions.delete(${JSON.stringify(sessionId)})`)
const listAfter = await evalInApp('window.api.sessions.list()')
check('Session gelöscht', deleted === true && !listAfter.some((s) => s.id === sessionId))

closeCdp()
console.log(failures === 0 ? '\nPDF-E2E: ALLE CHECKS GRÜN' : `\nPDF-E2E: ${failures} CHECK(S) ROT`)
process.exit(failures === 0 ? 0 : 1)
