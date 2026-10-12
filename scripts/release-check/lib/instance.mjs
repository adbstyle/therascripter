/**
 * Startet eine gepackte Therascript-App isoliert für die Release-Prüfung
 * (Issue #170) und spricht per CDP mit ihr.
 *
 * Isolation, drei Schichten:
 *   1. CFFIXED_USER_HOME lenkt das Home der App um — `app.getPath('home')`
 *      folgt NICHT der Variable HOME, sondern CoreFoundation, und
 *      CoreFoundation liest CFFIXED_USER_HOME zuerst. Damit liegen
 *      ~/.therascript und ~/Library/Application Support/therascript der App
 *      im Test-Home. Funktioniert ohne Produktänderung, also auch mit der
 *      bereits veröffentlichten Vorversion.
 *   2. sandbox-exec verbietet jeden Zugriff auf die echten Datenordner. Greift
 *      die Umlenkung nicht, scheitert die App, statt echte Daten anzufassen.
 *      Dazu: kein Internet — die Update-Prüfung gegen R2 machte Läufe sonst
 *      tagesabhängig. fdesetup NICHT sperren: execFile wirft dann synchron,
 *      checkFileVaultOnStartup bricht den Start vor taskQueue.start() ab, und
 *      wartende Sitzungen liefen nie los. Ein FileVault-Hinweis (nur ohne
 *      FileVault) blockiert die Prüfung nicht.
 *   3. Jeder Start prüft `aboutInfo().dataDir` gegen das Test-Home.
 *
 * `--use-mock-keychain`: Mit umgelenktem Home sucht macOS auch den
 * Schlüsselbund dort und fragt «A keychain cannot be found» — ein Dialog, der
 * ein unbeaufsichtigtes Gate blockiert. `--no-sandbox`: Chromiums eigene
 * Sandbox lässt sich nicht in sandbox-exec schachteln (siehe
 * scripts/sim-clean-install.sh).
 */
import { execFileSync, spawn } from 'child_process'
import { createWriteStream, mkdirSync, writeFileSync } from 'fs'
import { createServer } from 'net'
import { homedir } from 'os'
import { join } from 'path'

const REAL_HOME = homedir()

function sandboxProfile() {
  return `(version 1)
(allow default)
(deny file-read* file-write* (subpath "${REAL_HOME}/.therascript"))
(deny file-read* file-write* (subpath "${REAL_HOME}/Library/Application Support/therascript"))
(deny network-outbound (remote tcp "*:443"))
(deny network-outbound (remote tcp "*:80"))
`
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class CdpPage {
  constructor(ws) {
    this.ws = ws
    this.nextId = 0
    this.pending = new Map()
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      const resolve = msg.id && this.pending.get(msg.id)
      if (resolve) {
        this.pending.delete(msg.id)
        resolve(msg)
      }
    })
  }

  send(method, params) {
    return new Promise((resolve) => {
      const id = ++this.nextId
      this.pending.set(id, resolve)
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  /** Wertet einen Ausdruck im Renderer aus (Promises werden abgewartet). */
  async eval(expression, { timeoutMs = 60_000 } = {}) {
    const response = await Promise.race([
      this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
      sleep(timeoutMs).then(() => {
        throw new Error(`CDP-Timeout nach ${timeoutMs / 1000} s: ${expression.slice(0, 80)}`)
      })
    ])
    const details = response.result?.exceptionDetails
    if (details) {
      const text = details.exception?.description ?? details.text
      throw new Error(`Fehler in der App: ${String(text).slice(0, 400)}`)
    }
    return response.result?.result?.value
  }

  close() {
    this.ws.close()
  }
}

/**
 * Ein Verbindungsversuch zum Renderer. Liefert null, solange die App noch
 * startet (CDP-Port zu, noch kein Fenster, window.api noch nicht da). Alles
 * andere ist ein echter Fehler und wird geworfen — sonst erschiene z. B. ein
 * fehlendes WebSocket (Node < 22) nur als 60-s-Zeitüberschreitung.
 */
async function connectPage(port) {
  let targets
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  } catch (err) {
    if (err.cause?.code === 'ECONNREFUSED' || err.cause?.code === 'ECONNRESET') return null
    throw err
  }
  const target = targets.find((t) => t.type === 'page')
  if (!target) return null
  // globalThis: WebSocket ist erst ab Node 22 global, ESLint kennt es je
  // nach globals-Version (lokal) oder nicht (CI)
  const ws = new globalThis.WebSocket(target.webSocketDebuggerUrl)
  const opened = await new Promise((resolve) => {
    ws.onopen = () => resolve(true)
    ws.onerror = () => resolve(false)
  })
  if (!opened) return null
  const candidate = new CdpPage(ws)
  let ready = false
  try {
    ready = await candidate.eval('typeof window.api === "object"', { timeoutMs: 5000 })
  } catch {
    // Renderer lädt noch (Kontext ersetzt, Timeout) — nächster Versuch
  }
  if (ready) return candidate
  candidate.close()
  return null
}

/**
 * Startet die App und wartet, bis `window.api` im Renderer bereitsteht.
 * @param {{ appPath: string, home: string, logFile: string, label: string }} opts
 */
export async function launchInstance({ appPath, home, logFile, label }) {
  mkdirSync(join(home, 'tmp'), { recursive: true })
  const profilePath = join(home, 'sandbox.sb')
  writeFileSync(profilePath, sandboxProfile())
  const port = await freePort()

  const log = createWriteStream(logFile, { flags: 'a' })
  log.write(`\n===== ${new Date().toISOString()} ${label} (${appPath}) =====\n`)
  const binary = join(appPath, 'Contents', 'MacOS', 'Therascript')
  const child = spawn(
    'sandbox-exec',
    [
      '-f',
      profilePath,
      binary,
      '--no-sandbox',
      '--use-mock-keychain',
      `--remote-debugging-port=${port}`
    ],
    {
      env: {
        HOME: home,
        CFFIXED_USER_HOME: home,
        USER: process.env.USER,
        LOGNAME: process.env.LOGNAME ?? process.env.USER,
        SHELL: '/bin/zsh',
        TMPDIR: join(home, 'tmp') + '/',
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        __CF_USER_TEXT_ENCODING: process.env.__CF_USER_TEXT_ENCODING ?? '0x1F5:0x0:0x0'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  child.stdout.pipe(log)
  child.stderr.pipe(log)
  let exited = false
  const exitPromise = new Promise((resolve) =>
    child.on('exit', (code, signal) => {
      exited = true
      resolve({ code, signal })
    })
  )

  let page
  const deadline = Date.now() + 60_000
  while (!page) {
    if (exited) throw new Error(`${label}: App hat sich beim Start beendet (Log: ${logFile})`)
    if (Date.now() > deadline) {
      child.kill('SIGKILL')
      throw new Error(`${label}: App nicht innert 60 s per CDP erreichbar (Log: ${logFile})`)
    }
    page = await connectPage(port)
    if (!page) await sleep(500)
  }

  const dataDir = await page.eval('window.api.system.aboutInfo().then((i) => i.dataDir)')
  const expected = join(home, '.therascript')
  // macOS meldet /tmp-Pfade teils als /private/tmp — nur das Ende vergleichen
  if (!dataDir || !dataDir.endsWith(expected.replace(/^\/private/, ''))) {
    child.kill('SIGKILL')
    throw new Error(
      `${label}: Isolation greift nicht — dataDir ist ${dataDir}, erwartet ${expected}`
    )
  }

  return {
    page,
    pid: child.pid,
    /**
     * Beendet die App wie «Therascript beenden»: ein macOS-«Beenden» an genau
     * diesen Prozess (NSRunningApplication.terminate), dabei laufen
     * before-quit und das geordnete Herunterfahren von Aufnahme und
     * Warteschlange. Nicht SIGTERM: Die Bibliothek atomically (über
     * electron-store) fängt SIGTERM ab und reicht es nicht an Electron weiter
     * — die App würde nie beendet.
     */
    async quit() {
      page.close()
      if (exited) return exitPromise
      execFileSync('osascript', [
        '-l',
        'JavaScript',
        '-e',
        `ObjC.import('AppKit'); const a = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${child.pid}); a.isNil() ? false : a.terminate`
      ])
      const result = await Promise.race([exitPromise, sleep(30_000).then(() => null)])
      if (result) return result
      child.kill('SIGKILL')
      throw new Error(`${label}: App hat sich nach «Beenden» nicht innert 30 s beendet`)
    },
    kill() {
      if (!exited) child.kill('SIGKILL')
    }
  }
}

/** Wiederholt `probe`, bis sie einen Wert liefert, sonst Fehler mit `what`. */
export async function waitFor(probe, { what, timeoutMs, intervalMs = 2000 }) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() > deadline)
      throw new Error(`Zeitüberschreitung (${timeoutMs / 1000} s): ${what}`)
    await sleep(intervalMs)
  }
}
