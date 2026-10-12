#!/usr/bin/env node
/**
 * Erzeugt die Testdaten der Release-Prüfung (Issue #170) nach
 * tests/fixtures/release-check/ — einmalig, das Ergebnis wird committet:
 *
 *   gespraech.wav  ~20 s erfundenes Gespräch zweier Stimmen (macOS «say»),
 *                  48 kHz mono 16-bit, 44-Byte-Header — das Aufnahmeformat
 *   bericht.pdf    Seite 1 mit Textebene, Seite 2 nur als Bild (eingescannt,
 *                  < 50 Zeichen Text → Texterkennung über vision-ocr)
 *
 * Die Inhalte sind erfunden (NFR 2: keine echten Patientendaten), enthalten
 * aber Namen und Orte, damit die Pseudonymisierung etwas zu tun hat.
 *
 * Usage: node scripts/release-check/build-fixtures.mjs
 * Braucht macOS (say, afconvert, qlmanage), Google Chrome, ImageMagick und
 * pdfunite (poppler). Die Release-Prüfung selbst braucht nichts davon.
 */
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const OUT = join(ROOT, 'tests', 'fixtures', 'release-check')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const RATE = 48000

const TURNS = [
  [
    'Anna',
    'Guten Tag. Ich bin Laura Meier aus Winterthur. Seit dem Umzug schlafe ich schlecht und grüble abends viel über die Arbeit.'
  ],
  [
    'Reed',
    'Danke, Frau Meier. Wir schauen uns Ihren Schlafrhythmus an und vereinbaren für nächste Woche ein Schlaftagebuch.'
  ]
]

const TEXT_PAGE = `<!doctype html><meta charset="utf-8"><style>
body{font-family:Helvetica,Arial,sans-serif;font-size:13pt;line-height:1.5;margin:2.5cm}
h1{font-size:18pt}</style>
<h1>Verlaufsbericht</h1>
<p>Klient: Daniel Brunner, wohnhaft in Luzern.</p>
<p>Herr Brunner berichtet über anhaltende Erschöpfung seit dem Stellenwechsel im Frühling.
Er schläft unruhig, zieht sich von Freunden zurück und hat das Joggen aufgegeben.
In der Sitzung haben wir Belastungen am Arbeitsplatz gesammelt und erste Entlastungsschritte
besprochen: feste Pausen, ein Gespräch mit der Teamleitung und zwei Spaziergänge pro Woche.</p>`

const SCAN_PAGE = `<!doctype html><meta charset="utf-8"><style>
body{font-family:Times,serif;font-size:14pt;line-height:1.6;margin:2.5cm}</style>
<h2>Nachtrag zur Sitzung</h2>
<p>Herr Brunner meldet sich nach zwei Wochen telefonisch. Die Pausen halte er meistens ein,
das Gespräch mit der Teamleitung in Zug sei gut verlaufen. Der Schlaf habe sich leicht
verbessert. Nächster Termin in drei Wochen.</p>`

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

function printPdf(html, pdfPath, work) {
  const htmlPath = join(work, `${Date.now()}-${Math.random()}.html`)
  writeFileSync(htmlPath, html)
  execFileSync(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-pdf-header-footer',
      `--print-to-pdf=${pdfPath}`,
      `file://${htmlPath}`
    ],
    { stdio: 'ignore' }
  )
}

mkdirSync(OUT, { recursive: true })
const work = mkdtempSync(join(tmpdir(), 'therascript-release-fixtures-'))
try {
  // ── Gespräch ───────────────────────────────────────────────────────────
  const silence = Buffer.alloc(Math.round(1.5 * RATE) * 2)
  const parts = []
  TURNS.forEach(([voice, text], i) => {
    const aiff = join(work, `t${i}.aiff`)
    const wav = join(work, `t${i}.wav`)
    execFileSync('say', ['-v', voice, '-o', aiff, text])
    execFileSync('afconvert', ['-f', 'WAVE', '-d', `LEI16@${RATE}`, '-c', '1', aiff, wav])
    const data = readFileSync(wav)
    if (i > 0) parts.push(silence)
    parts.push(data.subarray(data.indexOf(Buffer.from('data')) + 8))
  })
  // Stille am Anfang und Ende wie bei einer echten Aufnahme
  const pcm = Buffer.concat([silence, ...parts, silence])
  writeFileSync(join(OUT, 'gespraech.wav'), Buffer.concat([wavHeader(pcm.length), pcm]))
  console.log(`gespraech.wav: ${(pcm.length / (RATE * 2)).toFixed(1)} s`)

  // ── PDF: Textseite + eingescannte Seite ───────────────────────────────
  const textPdf = join(work, 'text.pdf')
  const scanSource = join(work, 'scan-source.pdf')
  printPdf(TEXT_PAGE, textPdf, work)
  printPdf(SCAN_PAGE, scanSource, work)

  execFileSync('qlmanage', ['-t', '-s', '1700', '-o', work, scanSource], { stdio: 'ignore' })
  const thumb = join(
    work,
    readdirSync(work).find((f) => f.startsWith('scan-source.pdf') && f.endsWith('.png'))
  )
  const scannedPng = join(work, 'scan.png')
  execFileSync('magick', [
    thumb,
    '-background',
    'white',
    '-alpha',
    'remove',
    '-colorspace',
    'Gray',
    '-rotate',
    '0.6',
    '-attenuate',
    '0.3',
    '+noise',
    'Gaussian',
    '-level',
    '8%,92%',
    scannedPng
  ])
  const scanPdf = join(work, 'scan.pdf')
  execFileSync('magick', [
    scannedPng,
    '-density',
    '150',
    '-units',
    'PixelsPerInch',
    '-compress',
    'jpeg',
    '-quality',
    '75',
    scanPdf
  ])
  execFileSync('pdfunite', [textPdf, scanPdf, join(OUT, 'bericht.pdf')])
  console.log('bericht.pdf: Textseite + eingescannte Seite')
} finally {
  rmSync(work, { recursive: true, force: true })
}
