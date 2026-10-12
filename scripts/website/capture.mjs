#!/usr/bin/env node
/**
 * Nimmt Standbilder und Animationen der Landing Page (Epic #172) aus einer laufenden
 * TheraScript-Demo-Instanz auf — über CDP, mit echten Maus-Events auf der
 * echten Oberfläche. Ablauf und Voraussetzungen: docs/product/operations/website.md.
 *
 * Usage:
 *   CDP_PORT=9224 node scripts/website/capture.mjs stills <out-dir>
 *   CDP_PORT=9224 node scripts/website/capture.mjs editor <out-dir>     (Animation: Begriff → Sperrliste)
 *   CDP_PORT=9224 node scripts/website/capture.mjs pdf <out-dir> <pdf>  (Animation: PDF-Import)
 *   CDP_PORT=9224 node scripts/website/capture.mjs aufnahme <out-dir>   (Animation: Aufnahme → Transkript)
 *
 * Jede Aufnahme entsteht in hellem und dunklem Erscheinungsbild (<name>-light/-dark).
 * Animationen landen als Einzelbilder plus Zeitachse in <out-dir>/<name>-<theme>/,
 * build-gifs.sh macht daraus die GIFs und die Endzustands-Standbilder.
 *
 * Der Screencast zeigt nur den Fensterinhalt: Ampel-Knöpfe und Mauszeiger blendet
 * das Skript als Overlay ein (die Ampel liegt bei hiddenInset an trafficLightPosition
 * 15/11, siehe createWindow in src/main/index.ts).
 */
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { send as rawSend, evalInApp, onEvent, closeCdp } from '../e2e/cdp.mjs'
import { assertDemoInstance } from './demo/guard.mjs'

/** CDP-Aufruf mit Timeout: ein hängender Befehl soll den Lauf abbrechen, nicht blockieren. */
async function send(method, params) {
  let timer
  const r = await Promise.race([
    rawSend(method, params),
    new Promise(
      (_, rej) => (timer = setTimeout(() => rej(new Error(`CDP-Timeout: ${method}`)), 15_000))
    )
  ])
  clearTimeout(timer)
  if (r.error) throw new Error(`${method}: ${r.error.message}`)
  return r
}

const [MODE, OUT, ARG] = process.argv.slice(2)
if (!MODE || !OUT) {
  console.error(
    'Usage: node scripts/website/capture.mjs <stills|editor|pdf|aufnahme> <out-dir> [pdf]'
  )
  process.exit(1)
}
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const WIDTH = 1000
const HEIGHT = 660

// ── Fenster, Overlay, Theme ──────────────────────────────────────────────────

async function setWindow() {
  // Browser.setWindowBounds gibt es auf dem Page-Target nicht; die Emulation legt
  // die Fenstergrösse für Screenshot und Screencast fest (Retina: Faktor 2).
  await send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 2,
    mobile: false
  })
  // Ein verdecktes Fenster liefert Eingaben nur verzögert (mouseMoved bis 5 s).
  await send('Page.bringToFront', {})
  await sleep(400)
}

const OVERLAY = `(() => {
  if (document.getElementById('__cap')) return true
  const root = document.createElement('div')
  root.id = '__cap'
  root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647'
  ;['#ff5f57', '#febc2e', '#28c840'].forEach((c, i) => {
    const d = document.createElement('div')
    d.style.cssText = 'position:absolute;top:11px;left:' + (15 + i * 20) + 'px;width:12px;height:12px;border-radius:50%;background:' + c + ';box-shadow:inset 0 0 0 0.5px rgba(0,0,0,.18)'
    root.appendChild(d)
  })
  const cur = document.createElement('div')
  cur.id = '__cur'
  cur.style.cssText = 'position:absolute;left:-40px;top:-40px;width:22px;height:22px;display:none'
  cur.innerHTML = '<svg viewBox="0 0 22 22" width="22" height="22"><path d="M3 2 L3 18 L7.2 14 L10 20.5 L12.6 19.4 L9.9 13.2 L15.8 13.2 Z" fill="#000" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>'
  root.appendChild(cur)
  document.body.appendChild(root)
  return true
})()`

async function overlay() {
  await evalInApp(OVERLAY)
}

async function setTheme(theme) {
  await evalInApp(`window.api.settings.set('theme', '${theme}')`)
  await send('Page.reload', {})
  await sleep(1500)
  await dismissBanners()
  await overlay()
}

/** Update-Hinweise gehören nicht ins Bild. */
async function dismissBanners() {
  await evalInApp(`(() => {
    document.querySelector('[aria-label="Update-Hinweis ausblenden"]')?.click()
    return true
  })()`)
  await sleep(300)
}

// ── DOM-Helfer und Maus ──────────────────────────────────────────────────────

/** Mittelpunkt des sichtbaren Elements mit genau diesem Text (oder aria-label/title). */
async function centerOf(
  text,
  { selector = 'button, [role="button"], [role="menuitem"], a, div, span', nth = 0 } = {}
) {
  const r = await evalInApp(`(() => {
    const t = ${JSON.stringify(text)}
    const hits = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((el) => {
      const own = (el.innerText || '').trim()
      const lab = el.getAttribute('aria-label') || el.getAttribute('title') || ''
      if (!(own === t || lab === t)) return false
      const b = el.getBoundingClientRect()
      return b.width > 0 && b.height > 0
    })
    const el = hits[${nth}]
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    const b = el.getBoundingClientRect()
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  })()`)
  if (!r) throw new Error(`Element «${text}» nicht gefunden`)
  return r
}

let mouse = { x: WIDTH / 2, y: HEIGHT / 2 }
/** Blendet den Zeiger an der aktuellen Mausposition ein — nicht dort, wo er zuletzt stand. */
async function showCursor(on) {
  await evalInApp(`(() => {
    const c = document.getElementById('__cur')
    c.style.left = '${mouse.x - 3}px'
    c.style.top = '${mouse.y - 2}px'
    c.style.display = '${on ? 'block' : 'none'}'
    return true
  })()`)
}
async function moveTo(x, y, { steps = 14, button = 'none' } = {}) {
  const from = { ...mouse }
  for (let i = 1; i <= steps; i++) {
    const k = i / steps
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2
    const p = { x: from.x + (x - from.x) * e, y: from.y + (y - from.y) * e }
    await evalInApp(
      `(() => { const c = document.getElementById('__cur'); c.style.left = '${p.x - 3}px'; c.style.top = '${p.y - 2}px'; return true })()`
    )
    const t = Date.now()
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: p.x,
      y: p.y,
      button,
      buttons: button === 'left' ? 1 : 0
    })
    if (process.env.DEBUG && Date.now() - t > 500)
      console.log(`      langsam: mouseMoved ${Date.now() - t} ms`)
    await sleep(16)
  }
  mouse = { x, y }
}
async function click(x, y) {
  if (process.env.DEBUG) console.log(`      → ${Math.round(x)}/${Math.round(y)}`)
  await moveTo(x, y)
  await sleep(120)
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    buttons: 1,
    clickCount: 1
  })
  await sleep(70)
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    buttons: 0,
    clickCount: 1
  })
}
async function clickText(text, opts) {
  if (process.env.DEBUG)
    console.log(`    ${new Date().toISOString().slice(14, 19)} klick «${text}»`)
  const p = await centerOf(text, opts)
  await click(p.x, p.y)
}
async function drag(a, b) {
  await moveTo(a.x, a.y)
  await sleep(150)
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: a.x,
    y: a.y,
    button: 'left',
    buttons: 1,
    clickCount: 1
  })
  await moveTo(b.x, b.y, { steps: 24, button: 'left' })
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: b.x,
    y: b.y,
    button: 'left',
    buttons: 0,
    clickCount: 1
  })
}

/** Viewport-Rechteck eines Worts im Editor-Text (erstes Vorkommen). */
async function wordRect(word) {
  return evalInApp(`(() => {
    const root = document.querySelector('.ProseMirror')
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let n
    while ((n = walker.nextNode())) {
      const i = n.data.indexOf(${JSON.stringify(word)})
      if (i < 0) continue
      const r = document.createRange()
      r.setStart(n, i); r.setEnd(n, i + ${word.length})
      r.startContainer.parentElement.scrollIntoView({ block: 'center' })
      const b = r.getBoundingClientRect()
      return { left: b.left, right: b.right, y: b.top + b.height / 2 }
    }
    return null
  })()`)
}

// ── Navigation ───────────────────────────────────────────────────────────────

async function sessions() {
  return evalInApp('window.api.sessions.list()')
}
async function toList() {
  const inEditor = await evalInApp(`!!document.querySelector('[aria-label="Editor schließen"]')`)
  if (inEditor) await clickText('Editor schließen', { selector: 'button' })
  else await clickText('Transkriptionen', { selector: 'button' })
  await sleep(700)
}
async function openSession(title) {
  await clickText(title, { selector: 'h3, [class*="font-"]' }).catch(async () => {
    // Fallback: Karte über ihren Titeltext suchen
    const p = await evalInApp(`(() => {
      const el = [...document.querySelectorAll('*')].find((e) => e.childElementCount === 0 && e.textContent.trim() === ${JSON.stringify(title)})
      if (!el) return null
      el.scrollIntoView({ block: 'center' })
      const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
    })()`)
    if (!p) throw new Error(`Sitzung «${title}» nicht gefunden`)
    await click(p.x, p.y)
  })
  await sleep(1200)
}
async function sidePanel(open) {
  // aria-pressed am Umschalter ist der verlässliche Zustand; die Tab-Liste der
  // Seitenleiste bleibt auch geschlossen im DOM.
  const isOpen = await evalInApp(
    `document.querySelector('[aria-label="Seitenleiste anzeigen"]')?.getAttribute('aria-pressed') === 'true'`
  )
  if (isOpen !== open) {
    await clickText('Seitenleiste anzeigen', { selector: 'button' })
    await sleep(500)
  }
}

/** Wartet, bis die Sitzung fertig verarbeitet ist (inkl. Zusammenfassung); Frist 15 min. */
async function waitForSession(find, what) {
  const deadline = Date.now() + 900_000
  while (Date.now() < deadline) {
    const s = find(await sessions())
    if (s?.status === 'error') throw new Error(`${what}: ${s.errorMessage}`)
    if (s?.status === 'review' && !(await evalInApp('window.api.tasks.isProcessing()'))) return s
    await sleep(1000)
  }
  throw new Error(`${what}: nicht innerhalb von 15 min fertig`)
}

// ── Aufnahme ─────────────────────────────────────────────────────────────────

async function still(name) {
  await sleep(500)
  const t = Date.now()
  const r = await send('Page.captureScreenshot', { format: 'png' })
  if (process.env.DEBUG) console.log(`      Screenshot ${Date.now() - t} ms`)
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.result.data, 'base64'))
  console.log(`  ${name}.png`)
}

/** Screencast mitschneiden; Einzelbilder + timeline.json (Sekunden pro Bild). */
function startScreencast(name) {
  const dir = join(OUT, name)
  mkdirSync(dir, { recursive: true })
  const frames = []
  const off = onEvent(async (msg) => {
    if (msg.method !== 'Page.screencastFrame') return
    const { data, metadata, sessionId } = msg.params
    frames.push({ data, t: metadata.timestamp })
    send('Page.screencastFrameAck', { sessionId })
  })
  // JPEG statt PNG: ~1400 Bilder pro Aufnahme-Animation, das GIF wird ohnehin auf 880 px
  // verkleinert. Die doppelte Auflösung bleibt für das Endzustands-Standbild.
  send('Page.startScreencast', {
    format: 'jpeg',
    quality: 92,
    maxWidth: WIDTH * 2,
    maxHeight: HEIGHT * 2,
    everyNthFrame: 1
  })
  return {
    /**
     * Wartezeiten ohne Bewegung (z. B. Verarbeitung) auf `maxGap` Sekunden kürzen;
     * `fast` = [von, bis] (Epoch-Sekunden) läuft mit `fastFactor` beschleunigt.
     */
    async stop({ maxGap = 1.6, holdEnd = 2.5, fast = null, fastFactor = 0.4 } = {}) {
      await sleep(400)
      await send('Page.stopScreencast', {})
      off()
      const timeline = frames.map((f, i) => {
        const next = frames[i + 1]
        let d = next ? Math.min(next.t - f.t, maxGap) : holdEnd
        if (next && fast && f.t >= fast[0] && f.t <= fast[1]) d *= fastFactor
        const file = `f${String(i).padStart(4, '0')}.jpg`
        writeFileSync(join(dir, file), Buffer.from(f.data, 'base64'))
        return { file, duration: Number(d.toFixed(3)) }
      })
      writeFileSync(join(dir, 'timeline.json'), JSON.stringify(timeline, null, 1))
      console.log(`  ${name}/ ${frames.length} Bilder`)
    }
  }
}

// ── Szenarien ────────────────────────────────────────────────────────────────

async function stills() {
  const list = await sessions()
  const haupt = list.find((s) => s.type === 'audio' && (s.anonymizationCount ?? 0) >= 8) ?? list[0]
  const multi =
    list.find(
      (s) =>
        s.type === 'audio' &&
        s.id !== haupt.id &&
        /Prüfung|Jonas|Schule/i.test(`${s.title} ${s.summary ?? ''}`)
    ) ?? list.find((s) => s.type === 'audio' && s.id !== haupt.id)
  for (const theme of ['light', 'dark']) {
    await setTheme(theme)
    await toList()
    await showCursor(false)
    await still(`sitzungen-${theme}`)
    await openSession(haupt.title)
    await sidePanel(true)
    await still(`editor-${theme}`)
    await sidePanel(false)
    await toList()
    await openSession(multi.title)
    await still(`sprecher-${theme}`)
    await toList()
  }
}

async function editorAnimation() {
  const list = await sessions()
  const haupt = list.find((s) => s.type === 'audio' && (s.anonymizationCount ?? 0) >= 8) ?? list[0]
  // Ausgangszustand sichern: Die Animation ersetzt «Panikstörung» dauerhaft.
  const snapshot = await evalInApp(`window.api.review.load(${JSON.stringify(haupt.id)})`)
  for (const theme of ['light', 'dark']) {
    try {
      await setTheme(theme)
      await toList()
      await openSession(haupt.title)
      // Ohne Seitenleiste bleibt der Text im GIF gross genug zum Lesen.
      await sidePanel(false)
      const w = await wordRect('Panikstörung')
      if (!w) {
        throw new Error(
          '«Panikstörung» steht nicht (mehr) als Klartext im Transkript — Demo neu laden'
        )
      }
      mouse = { x: w.left - 60, y: w.y + 70 }
      await showCursor(true)
      const rec = startScreencast(`editor-${theme}`)
      await sleep(1500)
      await drag({ x: w.left + 1, y: w.y }, { x: w.right - 1, y: w.y })
      await sleep(900)
      await clickText('Auf Sperrliste setzen', { selector: '[role="menuitem"]' })
      await sleep(700)
      await clickText('Medizinisch', { selector: '[role="menuitem"]' })
      await sleep(1100)
      await clickText('Hinzufügen', { selector: 'button' })
      await sleep(1800)
      await moveTo(mouse.x + 40, mouse.y + 140)
      await rec.stop({ holdEnd: 3 })
    } finally {
      // Ausgangszustand wiederherstellen — auch wenn der Lauf abbricht.
      await showCursor(false)
      await toList()
      const entry = (await evalInApp('window.api.blocklist.list()')).find(
        (e) => e.term === 'Panikstörung'
      )
      if (entry) await evalInApp(`window.api.blocklist.delete(${JSON.stringify(entry.id)})`)
      await evalInApp(
        `window.api.review.save(${JSON.stringify(haupt.id)}, ${JSON.stringify(snapshot.document)}, ${JSON.stringify(snapshot.entityMap)})`
      )
    }
  }
}

async function pdfAnimation(pdfPath) {
  for (const theme of ['light', 'dark']) {
    await setTheme(theme)
    await toList()
    mouse = { x: WIDTH - 260, y: 200 }
    await showCursor(true)
    const rec = startScreencast(`pdf-${theme}`)
    await sleep(1200)
    // Import über die Renderer-API (der native Dateidialog ist im Screencast nicht sichtbar);
    // die Karte durchläuft danach sichtbar Text auslesen, Schrift erkennen, Pseudonymisieren.
    const p = await centerOf('PDF importieren', { selector: 'button' })
    await moveTo(p.x, p.y)
    await sleep(500)
    const [s] = await evalInApp(`window.api.import.pdf(${JSON.stringify([pdfPath])})`)
    await moveTo(p.x - 300, p.y + 260)
    const done = await waitForSession((l) => l.find((x) => x.id === s.id), 'PDF-Import')
    await sleep(1200)
    await openSession(done.title)
    await sleep(1500)
    await rec.stop({ maxGap: 0.8, holdEnd: 3 })
    await showCursor(false)
    await toList()
    await evalInApp(`window.api.sessions.delete(${JSON.stringify(s.id)})`)
  }
}

async function recordingAnimation() {
  // Erwartet eine Instanz, die mit Chromiums Fake-Mikrofon gestartet wurde
  // (scripts/website/demo/start-demo-instance.sh … --fake-mic <wav>).
  for (const theme of ['light', 'dark']) {
    await setTheme(theme)
    await toList()
    mouse = { x: WIDTH - 380, y: 260 }
    await showCursor(true)
    const before = new Set((await sessions()).map((s) => s.id))
    const rec = startScreencast(`aufnahme-${theme}`)
    await sleep(1200)
    await clickText('Aufnahme starten', { selector: 'button' })
    const fastFrom = Date.now() / 1000 + 1.5
    // Länge von aufnahme-animation.wav (Kurzdialog aus sitzungen.json) plus Reserve
    await sleep(10_500)
    const fastTo = Date.now() / 1000 - 0.5
    await clickText('Aufnahme stoppen', { selector: 'button' })
    await moveTo(mouse.x - 200, mouse.y + 250)
    const s = await waitForSession((l) => l.find((x) => !before.has(x.id)), 'Aufnahme')
    await sleep(1200)
    await openSession(s.title)
    await sleep(1500)
    await rec.stop({ maxGap: 0.8, holdEnd: 3, fast: [fastFrom, fastTo] })
    await showCursor(false)
    await toList()
    await evalInApp(`window.api.sessions.delete(${JSON.stringify(s.id)})`)
  }
}

try {
  await assertDemoInstance(evalInApp)
  await setWindow()
  if (MODE === 'stills') await stills()
  else if (MODE === 'editor') await editorAnimation()
  else if (MODE === 'pdf') await pdfAnimation(ARG)
  else if (MODE === 'aufnahme') await recordingAnimation()
  else throw new Error(`Unbekannter Modus ${MODE}`)
  await setTheme('light')
} finally {
  closeCdp()
}
