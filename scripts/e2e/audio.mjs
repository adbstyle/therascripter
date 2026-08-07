#!/usr/bin/env node
/**
 * Audio-E2E gegen die ECHTE (gepackte) App: synthetisierte deutsche Sprache
 * (zwei say-Stimmen mit Stille-Lücken) wird über die reguläre Recording-IPC
 * (recording:start/data/stop — exakt der Mikrofon-Worklet-Pfad) eingespeist
 * und der komplette Pipeline-Durchlauf verifiziert:
 * Diarization → PCM-Stitch → Whisper → Alignment → NER → review.
 *
 * Vorbereitung:
 *   dist/mac-arm64/Therascript.app/Contents/MacOS/Therascript --remote-debugging-port=9223 &
 * Usage:
 *   node scripts/e2e/audio.mjs
 *
 * Braucht installierte Modelle in ~/.therascript/models (ASR, Diarization,
 * NER). Räumt die Test-Session am Ende wieder weg; bei Fehlschlag bleibt sie
 * zur Diagnose erhalten.
 */
import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { evalInApp, closeCdp } from './cdp.mjs'

const started = Date.now()
const log = (m) => console.log(`[${((Date.now() - started) / 1000).toFixed(0)}s] ${m}`)
let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

/** Nur sichtbare Textknoten — Chip-Attribute tragen designbedingt das Original
 *  (Editor-Revert). Sie zu prüfen wäre ein False Positive, kein Leck. */
function visibleText(node, out = []) {
  if (node.type === 'text') out.push(node.text)
  for (const c of node.content ?? []) visibleText(c, out)
  return out
}

// ── 1. Zwei-Stimmen-Session synthetisieren (macOS say + afconvert) ──────────
// Die PII-Terme unten sind die Assertions-Grundlage: sie dürfen im sichtbaren
// Text NICHT mehr auftauchen.
const PII = ['Bergmann', 'Maria', 'Winterthur', 'Zürich', 'Thomas']
const TURNS = [
  ['Anna', 'Guten Tag Herr Doktor. Ich bin Maria Bergmann aus Winterthur. Seit drei Wochen schlafe ich sehr schlecht und grüble viel über meine Arbeit.'],
  ['Reed', 'Danke, dass Sie gekommen sind, Frau Bergmann. Erzählen Sie mir bitte, wann diese Schlafprobleme angefangen haben.'],
  ['Anna', 'Es begann nach dem Umzug nach Zürich im Juni. Mein Bruder Thomas meint, ich solle mehr Sport machen, aber die Physiotherapie hilft nur wenig.'],
  ['Reed', 'Das klingt belastend. Wir schauen uns das gemeinsam an und besprechen heute erste Schritte für einen besseren Schlafrhythmus.']
]

log('Synthetisiere Session-Audio (2 Stimmen, 1.5 s Stille zwischen Turns) …')
const workDir = mkdtempSync(join(tmpdir(), 'therascript-e2e-audio-'))
let payload = Buffer.alloc(0)
const silence = Buffer.alloc(Math.round(1.5 * 48000) * 2)
try {
  for (let i = 0; i < TURNS.length; i++) {
    const [voice, sentence] = TURNS[i]
    const aiff = join(workDir, `t${i}.aiff`)
    const wav = join(workDir, `t${i}.wav`)
    execFileSync('say', ['-v', voice, '-o', aiff, sentence])
    execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@48000', '-c', '1', aiff, wav])
    const data = readFileSync(wav)
    const pcm = data.subarray(data.indexOf(Buffer.from('data')) + 8)
    payload = Buffer.concat(i === 0 ? [payload, pcm] : [payload, silence, pcm])
  }
} finally {
  rmSync(workDir, { recursive: true, force: true })
}
const durationSec = payload.length / 96000
log(`${durationSec.toFixed(1)} s Audio erzeugt`)

// ── 2. Über die reguläre Recording-IPC einspeisen ───────────────────────────
const { sessionId } = await evalInApp('window.api.recording.start()')
check('recording:start liefert sessionId', typeof sessionId === 'string')

const CHUNK = 48000 // 1 s
const sampleCount = payload.length / 2
for (let off = 0; off < sampleCount; off += CHUNK) {
  const n = Math.min(CHUNK, sampleCount - off)
  const b64 = payload.subarray(off * 2, (off + n) * 2).toString('base64')
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
const stopResult = await evalInApp(`window.api.recording.stop(${JSON.stringify(sessionId)})`)
check(
  'stop liefert plausible Dauer (±2 s)',
  Math.abs(stopResult.durationSeconds - durationSec) < 2,
  `${stopResult.durationSeconds?.toFixed(1)}s`
)

// ── 3. Kompletten Pipeline-Durchlauf abwarten ───────────────────────────────
let session
let lastStatus = ''
const deadline = Date.now() + 900_000
while (Date.now() < deadline) {
  const list = await evalInApp('window.api.sessions.list()')
  session = list.find((s) => s.id === sessionId)
  if (session && session.status !== lastStatus) {
    lastStatus = session.status
    log(`Status: ${session.status}`)
  }
  if (session && (session.status === 'review' || session.status === 'error')) break
  await new Promise((r) => setTimeout(r, 5000))
}
check('Session erreicht review', session?.status === 'review', session?.errorMessage ?? '')
if (session?.status !== 'review') {
  console.log(`\nSession ${sessionId} bleibt zur Diagnose erhalten.`)
  closeCdp()
  process.exit(1)
}

// ── 4. Inhaltliche Assertions ───────────────────────────────────────────────
const review = await evalInApp(`window.api.review.load(${JSON.stringify(sessionId)})`)
const text = visibleText(review.document).join(' ')
const docJson = JSON.stringify(review.document)

check('Transkript enthält erkennbaren Inhalt ("Physiotherapie")', /physiotherapie/i.test(text))
check('Transkript enthält das Thema ("Schlaf")', /schlaf/i.test(text))
const leaks = PII.filter((n) => new RegExp(n, 'i').test(text))
check('Kein PII-Klartext im sichtbaren Text', leaks.length === 0, leaks.join(', ') || 'sauber')
check('Platzhalter-Chips vorhanden', docJson.includes('placeholderChip'), `anonymizationCount=${session.anonymizationCount}`)
check(
  'AudioStats vorhanden (StitchMap-Pfad lief, Stille entfernt)',
  review.audioStats != null && review.audioStats.stitchedDurationSec < review.audioStats.originalDurationSec,
  `original=${review.audioStats?.originalDurationSec?.toFixed(1)}s stitched=${review.audioStats?.stitchedDurationSec?.toFixed(1)}s`
)
check('Diarization erkennt 2 Sprecher', review.audioStats?.speakerCount === 2, `speakerCount=${review.audioStats?.speakerCount}`)

// ── 5. Aufräumen ────────────────────────────────────────────────────────────
log('Aufräumen …')
const deleted = await evalInApp(`window.api.sessions.delete(${JSON.stringify(sessionId)})`)
check('Test-Session gelöscht', deleted === true)

closeCdp()
console.log(failures === 0 ? '\nAUDIO-E2E: ALLE CHECKS GRÜN' : `\nAUDIO-E2E: ${failures} CHECK(S) ROT`)
process.exit(failures === 0 ? 0 : 1)
