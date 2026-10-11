#!/usr/bin/env node
/**
 * Erzeugt die Rohdaten der erfundenen Demo-Sitzung (Epic #172) aus den Quellen in
 * diesem Ordner:
 *   - <out>/<id>.pcm   Gespräch aus sitzungen.json, 48 kHz mono s16le (macOS «say»,
 *                      Tonhöhe je Stimme verschoben, 1.2 s Stille zwischen den Beiträgen)
 *   - <out>/<id>.wav   dasselbe mit WAV-Header (zum Anhören, für die Aufnahme-Animation)
 *   - <out>/bericht.pdf         Text-PDF aus bericht.html (Chrome headless)
 *   - <out>/bericht-scan.pdf    dasselbe als Bild-PDF (leicht gedreht, verrauscht)
 *
 * Usage: node scripts/website/demo/build-demo-assets.mjs <out-dir>
 * Braucht macOS (say, qlmanage), ffmpeg, Google Chrome und ImageMagick.
 * Die Tonspur wird nicht veröffentlicht (Out of Scope #176).
 */
import { execFileSync } from 'child_process'
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = process.argv[2]
if (!OUT) {
  console.error('Usage: node scripts/website/demo/build-demo-assets.mjs <out-dir>')
  process.exit(1)
}
mkdirSync(OUT, { recursive: true })
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const RATE = 48000
const work = mkdtempSync(join(tmpdir(), 'therascript-demo-'))

function wavHeader(dataBytes) {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + dataBytes, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(RATE, 24)
  h.writeUInt32LE(RATE * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(dataBytes, 40)
  return h
}

try {
  const { sitzungen, aufnahmeAnimation } = JSON.parse(readFileSync(join(HERE, 'sitzungen.json'), 'utf8'))
  const silence = Buffer.alloc(Math.round(1.2 * RATE) * 2)
  for (const s of [...sitzungen, aufnahmeAnimation]) {
    const parts = []
    s.turns.forEach(([voice, text], i) => {
      const aiff = join(work, `${s.id}-${i}.aiff`)
      const wav = join(work, `${s.id}-${i}.wav`)
      const [name, pitch = '1'] = voice.split('@')
      execFileSync('say', ['-v', name, '-r', '172', '-o', aiff, text])
      // Tonhöhe um den Faktor verschieben, Tempo beibehalten; say liefert 22.05 kHz.
      const f = Number(pitch)
      execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', aiff, '-af',
        `asetrate=22050*${f},aresample=${RATE},atempo=${1 / f}`,
        '-ac', '1', '-ar', String(RATE), '-c:a', 'pcm_s16le', wav])
      const data = readFileSync(wav)
      if (i > 0) parts.push(silence)
      parts.push(data.subarray(data.indexOf(Buffer.from('data')) + 8))
    })
    const pcm = Buffer.concat(parts)
    writeFileSync(join(OUT, `${s.id}.pcm`), pcm)
    writeFileSync(join(OUT, `${s.id}.wav`), Buffer.concat([wavHeader(pcm.length), pcm]))
    console.log(`${s.id}: ${(pcm.length / (RATE * 2)).toFixed(1)} s`)
  }

  const pdf = join(OUT, 'bericht.pdf')
  execFileSync(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-pdf-header-footer',
    `--print-to-pdf=${pdf}`,
    `file://${join(HERE, 'bericht.html')}`
  ], { stdio: 'ignore' })
  console.log(`bericht.pdf`)

  // «Scan»: erste Seite rastern, leicht drehen, Graustufen, Rauschen → Bild-PDF
  // ohne Textschicht (TheraScript erkennt es als gescannt und nutzt die OCR).
  execFileSync('qlmanage', ['-t', '-s', '1700', '-o', work, pdf], { stdio: 'ignore' })
  const thumb = join(work, readdirSync(work).find((f) => f.startsWith('bericht.pdf')))
  const scanned = join(work, 'scan.png')
  execFileSync('magick', [
    thumb,
    '-background', 'white', '-alpha', 'remove',
    '-colorspace', 'Gray',
    '-rotate', '0.7',
    '-attenuate', '0.35', '+noise', 'Gaussian',
    '-blur', '0x0.4',
    '-level', '8%,92%',
    scanned
  ])
  // In einem Schritt mit dem PDF-Export kam eine leere Seite heraus.
  const scan = join(OUT, 'bericht-scan.pdf')
  execFileSync('magick', [
    scanned, '-density', '150', '-units', 'PixelsPerInch', '-compress', 'jpeg', '-quality', '80', scan
  ])
  console.log(`bericht-scan.pdf`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
