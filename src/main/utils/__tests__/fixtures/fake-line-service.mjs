/* global process, Buffer, setTimeout, setInterval */
// Fake-Dienst mit dem Protokoll von python_sidecar/search_service.py (serve):
// JSON-Lines auf stdin/stdout, Startzeile, Antworten in Reihenfolge, Fehler mit
// id: null für unlesbare Zeilen, Exit bei stdin-EOF. Für die Lebenszyklus-
// Tests von LineProcess und SearchWorker — echte Prozesse, keine Mocks.
//
// Verhalten über Umgebungsvariablen:
//   FAKE_READY_DELAY_MS   Startzeile erst nach so vielen ms
//   FAKE_NO_READY=1       nie eine Startzeile
//   FAKE_EXIT_BEFORE_READY=<code>  vor der Startzeile beenden
//   FAKE_IGNORE_EOF=1     stdin-EOF ignorieren
//   FAKE_IGNORE_SIGTERM=1 SIGTERM ignorieren (nur SIGKILL hilft)
//   FAKE_FOOTPRINT_START  phys_footprint_bytes der ersten Antwort (Default 1 GiB)
//   FAKE_FOOTPRINT_STEP   Zuwachs pro Antwort (Default 0)
//   FAKE_DIM              Dimension der Vektoren (Default 768)
//   FAKE_LOG              Datei, in die jede Operation eine Zeile schreibt
import { appendFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

const env = process.env
const dim = Number(env.FAKE_DIM ?? 768)
let footprint = Number(env.FAKE_FOOTPRINT_START ?? 1024 * 1024 * 1024)
const footprintStep = Number(env.FAKE_FOOTPRINT_STEP ?? 0)

function log(entry) {
  if (env.FAKE_LOG) appendFileSync(env.FAKE_LOG, `${entry}\n`)
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

/** Deterministischer Vektor aus dem Text, L2-normalisiert, base64 float32 LE. */
function vectorFor(text) {
  const v = new Float32Array(dim)
  let seed = 0
  for (const ch of text) seed = (seed * 31 + ch.codePointAt(0)) >>> 0
  for (let i = 0; i < dim; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0
    v[i] = (seed / 0xffffffff) * 2 - 1
  }
  let norm = 0
  for (let i = 0; i < dim; i++) norm += v[i] * v[i]
  norm = Math.sqrt(norm)
  for (let i = 0; i < dim; i++) v[i] /= norm
  return Buffer.from(v.buffer).toString('base64')
}

process.stderr.write('Suchmodell geladen in 1 ms\n')
if (env.FAKE_IGNORE_SIGTERM === '1') process.on('SIGTERM', () => log('sigterm-ignored'))

const queue = []
let busy = false
let ended = false

async function handle(line) {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    send({ id: null, error: { code: 'bad_json', message: 'Zeile ist kein JSON' } })
    return
  }
  const { id, op } = msg
  log(op)
  const withFootprint = (response) => {
    footprint += footprintStep
    return { ...response, phys_footprint_bytes: footprint }
  }
  switch (op) {
    case 'ping':
      send(withFootprint({ id, ok: true, device: 'cpu', dtype: 'float32' }))
      return
    case 'echo':
      send(withFootprint({ id, echo: msg.value }))
      return
    case 'env':
      send({ id, env: process.env })
      return
    case 'sleep':
      await new Promise((r) => setTimeout(r, msg.ms))
      send(withFootprint({ id, slept: msg.ms }))
      return
    case 'big':
      send({ id, data: 'x'.repeat(msg.bytes), tail: 'Ende ä' })
      return
    case 'crash':
      process.exit(msg.code ?? 3)
      return
    case 'selfkill':
      process.kill(process.pid, 'SIGKILL')
      return
    case 'half':
      process.stdout.write('{"id": 99, "partial": tr', () => process.exit(0))
      return
    case 'spawn-holder': {
      // Enkelprozess in EIGENER Gruppe, der stdout/stderr erbt und offen hält
      const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], {
        detached: true,
        stdio: ['ignore', 'inherit', 'inherit']
      })
      holder.unref()
      send({ id, holderPid: holder.pid })
      return
    }
    case 'nullid':
      // Wie search_service.py bei einer unlesbaren bzw. zu grossen Zeile
      send({ id: null, error: { code: 'too_large', message: 'Zeile zu gross' } })
      return
    case 'garbage':
      process.stdout.write('das ist kein JSON\n')
      send({ id, ok: true })
      return
    case 'fail':
      send({ id, error: { code: msg.code ?? 'internal', message: msg.message ?? 'Fehler' } })
      return
    case 'embed_query':
      if (typeof msg.text !== 'string') {
        send({ id, error: { code: 'bad_request', message: 'text fehlt' } })
        return
      }
      if (env.FAKE_QUERY_DELAY_MS) {
        await new Promise((r) => setTimeout(r, Number(env.FAKE_QUERY_DELAY_MS)))
      }
      send(withFootprint({ id, dim, vector: vectorFor(msg.text) }))
      return
    case 'embed_documents':
      if (env.FAKE_BATCH_DELAY_MS) {
        await new Promise((r) => setTimeout(r, Number(env.FAKE_BATCH_DELAY_MS)))
      }
      if (env.FAKE_FAIL_DOCUMENTS === '1') {
        send({ id, error: { code: 'internal', message: 'Batch gescheitert' } })
        return
      }
      log(`texts:${JSON.stringify(msg.texts)}`)
      send(withFootprint({ id, dim, vectors: msg.texts.map(vectorFor) }))
      return
    case 'shutdown':
      send({ id, ok: true })
      process.exit(0)
      return
    default:
      send({ id, error: { code: 'unknown_op', message: `unbekannte Operation: ${op}` } })
  }
}

async function pump() {
  if (busy) return
  busy = true
  while (queue.length > 0) await handle(queue.shift())
  busy = false
  if (ended && env.FAKE_IGNORE_EOF !== '1') process.exit(0)
}

function listen() {
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    let at = buffer.indexOf('\n')
    while (at >= 0) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      if (line.trim()) queue.push(line)
      at = buffer.indexOf('\n')
    }
    void pump()
  })
  process.stdin.on('end', () => {
    ended = true
    log('eof')
    if (env.FAKE_IGNORE_EOF === '1') {
      // Prozess am Leben halten
      setInterval(() => undefined, 1000)
      return
    }
    if (!busy) process.exit(0)
  })
}

function ready() {
  if (env.FAKE_EXIT_BEFORE_READY !== undefined) {
    process.stderr.write('Fehler: Suchmodell konnte nicht geladen werden: kaputt\n')
    process.exit(Number(env.FAKE_EXIT_BEFORE_READY))
  }
  if (env.FAKE_NO_READY === '1') {
    setInterval(() => undefined, 1000)
    return
  }
  process.stderr.write('Gewichte: torch.float32 auf cpu\n')
  send({
    ready: true,
    device: 'cpu',
    dtype: 'float32',
    load_ms: 1,
    dim,
    phys_footprint_bytes: footprint
  })
}

listen()
const delay = Number(env.FAKE_READY_DELAY_MS ?? 0)
if (delay > 0) setTimeout(ready, delay)
else ready()
