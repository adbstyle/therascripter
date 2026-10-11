#!/usr/bin/env node
/**
 * Spielt die erfundene Demo-Sitzung (Epic #172) in eine laufende TheraScript-Instanz
 * ein — über dieselbe Renderer-API (window.api.*) wie scripts/e2e/audio.mjs:
 *   1. Sperrlisten-Einträge aus sperrliste.json
 *   2. jedes Gespräch aus sitzungen.json als Aufnahme (Recording-IPC, wie der
 *      Mikrofon-Worklet), Pipeline inklusive Zusammenfassung abwarten
 *   3. bericht.pdf und bericht-scan.pdf importieren und abwarten
 * Danach optional (--db) die Erstellungszeiten auf die in sitzungen.json
 * vorgesehenen Tage legen, damit die Sitzungsliste mehrere Tage zeigt.
 *
 * NIE gegen eine Instanz mit echten Daten laufen lassen: Die Demo gehört in eine
 * eigene Instanz mit eigenem Daten- und Settings-Ordner (siehe
 * docs/product/operations/website.md, «Demo-Sitzung neu erstellen»).
 *
 * Usage: CDP_PORT=9224 node scripts/website/demo/load-demo.mjs <assets-dir> [--db <therascript.db>]
 */
import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { evalInApp, closeCdp } from '../../e2e/cdp.mjs'
import { assertDemoInstance } from './guard.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ASSETS = process.argv[2]
const dbIdx = process.argv.indexOf('--db')
const DB = dbIdx > 0 ? process.argv[dbIdx + 1] : null
if (!ASSETS) {
  console.error(
    'Usage: node scripts/website/demo/load-demo.mjs <assets-dir> [--db <therascript.db>]'
  )
  process.exit(1)
}

const started = Date.now()
const log = (m) => console.log(`[${((Date.now() - started) / 1000).toFixed(0)}s] ${m}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const { sitzungen } = JSON.parse(readFileSync(join(HERE, 'sitzungen.json'), 'utf8'))
const { eintraege } = JSON.parse(readFileSync(join(HERE, 'sperrliste.json'), 'utf8'))

await assertDemoInstance(evalInApp).catch((e) => {
  console.error(e.message)
  closeCdp()
  process.exit(1)
})
const existing = await evalInApp('window.api.sessions.list()')
if (existing.length > 0) {
  console.error(
    `Abbruch: Die Instanz hat bereits ${existing.length} Sitzungen. Nur in eine leere Demo-Instanz einspielen.`
  )
  closeCdp()
  process.exit(1)
}

/** Wartet auf review und — falls ein Zusammenfassungsmodell aktiv ist — auf die Zusammenfassung. */
async function waitDone(sessionId) {
  const deadline = Date.now() + 1_200_000
  let last = ''
  while (Date.now() < deadline) {
    const s = (await evalInApp('window.api.sessions.list()')).find((x) => x.id === sessionId)
    if (s?.status !== last) log(`  Status: ${(last = s?.status)}`)
    if (s?.status === 'error') throw new Error(`Session ${sessionId}: ${s.errorMessage}`)
    if (s?.status === 'review') {
      const busy = await evalInApp('window.api.tasks.isProcessing()')
      if (!busy) return s
    }
    await sleep(3000)
  }
  throw new Error(`Timeout für Session ${sessionId}`)
}

log('Sperrliste …')
for (const e of eintraege)
  await evalInApp(
    `window.api.blocklist.add(${JSON.stringify(e.begriff)}, ${JSON.stringify(e.typ)})`
  )

const created = []
// Älteste zuerst, damit die Reihenfolge der Erstellung zur Liste passt.
for (const s of [...sitzungen].sort((a, b) => b.tageZurueck - a.tageZurueck)) {
  log(`Aufnahme «${s.id}» …`)
  const pcm = readFileSync(join(ASSETS, `${s.id}.pcm`))
  const { sessionId } = await evalInApp('window.api.recording.start()')
  const CHUNK = 48000
  for (let off = 0; off < pcm.length / 2; off += CHUNK) {
    const n = Math.min(CHUNK, pcm.length / 2 - off)
    const b64 = pcm.subarray(off * 2, (off + n) * 2).toString('base64')
    await evalInApp(`(() => {
      const bin = atob(${JSON.stringify(b64)})
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const int16 = new Int16Array(bytes.buffer)
      const f32 = new Float32Array(int16.length)
      for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768
      window.api.recording.sendData(${JSON.stringify(sessionId)}, f32.buffer)
      return true
    })()`)
  }
  await evalInApp(`window.api.recording.stop(${JSON.stringify(sessionId)})`)
  const done = await waitDone(sessionId)
  log(`  → «${done.title}», ${done.anonymizationCount ?? '?'} Pseudonymisierungen`)
  created.push({ id: sessionId, tageZurueck: s.tageZurueck, uhrzeit: s.uhrzeit })
}

for (const [file, tage, zeit] of [
  ['bericht.pdf', 2, '09:10'],
  ['bericht-scan.pdf', 2, '09:12']
]) {
  log(`PDF «${file}» …`)
  const [s] = await evalInApp(`window.api.import.pdf(${JSON.stringify([join(ASSETS, file)])})`)
  const done = await waitDone(s.id)
  log(`  → «${done.title}»`)
  created.push({ id: s.id, tageZurueck: tage, uhrzeit: zeit })
}
closeCdp()

if (DB) {
  log('Erstellungszeiten setzen …')
  const sql = created
    .map(({ id, tageZurueck, uhrzeit }) => {
      const d = new Date()
      d.setDate(d.getDate() - tageZurueck)
      const [h, m] = uhrzeit.split(':').map(Number)
      d.setHours(h, m, 0, 0)
      return `UPDATE sessions SET created_at='${d.toISOString()}' WHERE id='${id}';`
    })
    .join('\n')
  execFileSync('sqlite3', [DB], { input: sql })
}
log(`Fertig: ${created.length} Sitzungen`)
