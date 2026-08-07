#!/usr/bin/env node
/**
 * Resolve-Gate für das gepackte app.asar.
 *
 * Fehlerklasse, die dieser Check abdeckt: eine Runtime-Dependency fehlt im
 * gepackten Bundle, ist in Dev aber vorhanden — sichtbar erst auf einem
 * Feature-Pfad, oft in einem lazy `import()`. Ein Liveness-Check ("App startet
 * 10 s") kann das strukturell nicht sehen, und eine Präsenzliste über
 * Top-Level-Ordner (verify-bundles.sh) prüft die falsche Eigenschaft: es zählt
 * nicht, ob ein Verzeichnis da ist, sondern ob jeder Specifier AUFLÖSBAR ist.
 *
 * Anlass: `!node_modules/@napi-rs/**` in electron-builder.yml entfernte den
 * einzigen DOMMatrix-Polyfill von pdfjs — PDF-Import war im DMG tot, während
 * Dev, Tests, Lint, Typecheck und der Startup-Smoke alle grün waren.
 *
 * Methode:
 *   1. app.asar entpacken, app.asar.unpacked darüberlegen (sonst schlagen
 *      native .node-Dateien fehl, die electron-builder auto-entpackt).
 *   2. Von out/main/index.js + out/preload/index.js aus per BFS alle
 *      require()/import()/from-Literale einsammeln.
 *   3. Jeden Specifier mit dem ECHTEN Node-Resolver auflösen (nicht über die
 *      Lockfile-Struktur — das erzeugt Fehlalarme bei mehrfach installierten
 *      Versionen, z. B. ajv 6 aus ESLint vs. ajv 8 aus electron-store).
 *   4. Nicht auflösbar ODER ausserhalb des Bundles ⇒ Exit 1.
 *
 * Usage: node scripts/verify-asar-resolves.mjs [pfad/zu/app.asar]
 */
import { execFileSync } from 'child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'fs'
import { createRequire } from 'module'
import { tmpdir } from 'os'
import { dirname, join, relative, resolve } from 'path'
import { isBuiltin } from 'module'

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..')
const asarPath =
  process.argv[2] ?? join(REPO_ROOT, 'dist/mac-arm64/Therascript.app/Contents/Resources/app.asar')

// Bewusst eine Allowlist (keine Regex-Aufweichung), damit jeder NEUE
// unauflösbare Specifier auffällt.
//
// REGEL: Ein Eintrag hier ist ein VERTRAG, kein Schweigemittel. Er braucht
// entweder den Nachweis, dass es gar kein Import ist, ODER — bei absichtlich
// nicht mitgelieferten optionalen Deps — den Test, der beweist, dass die App
// ohne sie funktioniert. Ohne diesen Nachweis gehört nichts auf diese Liste.
const ALLOWLIST = new Set([
  // Optionale Dep von pdfjs-dist, absichtlich NICHT gebundelt: 25 MB
  // Skia-Native-Lib, die wir nie brauchen (nur getTextContent, keine
  // Rasterung). pdfjs fängt den require() in try/catch (pdf.mjs, isNodeJS-
  // Block) und begnügt sich mit einem warn(). Die einzige Global, die pdfjs
  // daraus zwingend beim Import braucht (DOMMatrix), stellen wir selbst:
  // src/main/utils/pdfjs-loader.ts → installPdfjsBrowserGlobals().
  // BEWEIS: src/main/utils/__tests__/pdfjs-loader.test.ts macht das Paket
  // unauflösbar und extrahiert Text aus einer Fixture-PDF.
  '@napi-rs/canvas',
  // Reine JSDoc-Typannotationen (`@param {import('./types/index').…}`) in
  // fast-uri/{index,lib/utils,lib/schemes}.js — zur Laufzeit nie geladen.
  // Verifiziert per grep: alle Treffer stehen in Kommentarblöcken.
  './types/index',
  '../types/index',
  // Kein Import, sondern ein Fragment aus einem Code-Kommentar in
  // TaskQueueService ("… from 'error' back to 'review' …"), das die
  // Regex-Extraktion aus dem gebundelten out/main/index.js mitfängt.
  'error'
])

if (!existsSync(asarPath)) {
  console.error(`FAIL: app.asar nicht gefunden: ${asarPath}`)
  console.error('Zuerst `npm run package` ausführen.')
  process.exit(1)
}

// realpathSync: auf macOS ist /var ein Symlink auf /private/var. Ohne
// Auflösung liefert require.resolve() /private/var/… und jeder Vergleich
// gegen den mkdtemp-Pfad schlüge fehl ("löst ausserhalb des Bundles auf").
const workDir = realpathSync(mkdtempSync(join(tmpdir(), 'therascript-asar-resolve-')))
let failures = 0
let checked = 0

// Bare Specifier müssen ein gültiger npm-Paketname sein (npm verbietet
// Grossbuchstaben im Namensteil). Filtert String-Literale und JSDoc-Fragmente
// heraus, die die Regex-Extraktion unvermeidlich mitfängt — z. B. eine
// Log-Meldung `… from 'summaryModelId'` ist kein Import.
const PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(\/.*)?$/

function isModuleSpecifier(spec) {
  if (spec.startsWith('.') || spec.startsWith('/')) return true
  return PACKAGE_NAME.test(spec)
}

try {
  console.log(`Entpacke ${relative(REPO_ROOT, asarPath)} …`)
  execFileSync('npx', ['--yes', '@electron/asar', 'extract', asarPath, workDir], {
    stdio: 'inherit'
  })

  // Auto-entpackte native Module überlagern — ohne sie scheitert jedes
  // require() einer .node-Datei.
  const unpacked = `${asarPath}.unpacked`
  if (existsSync(unpacked)) {
    cpSync(unpacked, workDir, { recursive: true })
    console.log('app.asar.unpacked überlagert ✓')
  }

  const entryPoints = ['out/main/index.js', 'out/preload/index.js']
    .map((p) => join(workDir, p))
    .filter((p) => existsSync(p))

  if (entryPoints.length === 0) {
    console.error('FAIL: keine Entry-Points (out/main/index.js) im asar gefunden')
    process.exit(1)
  }

  // Specifier-Literale aus JS/MJS/CJS extrahieren
  const SPECIFIER_PATTERNS = [
    /\brequire\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
    /\bimport\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
    /\bfrom\s+["'`]([^"'`]+)["'`]/g,
    /^\s*import\s+["'`]([^"'`]+)["'`]/gm
  ]

  const visited = new Set()
  const queue = [...entryPoints]

  while (queue.length > 0) {
    const file = queue.shift()
    if (visited.has(file)) continue
    visited.add(file)

    let source
    try {
      source = readFileSync(file, 'utf-8')
    } catch {
      continue
    }

    const fileRequire = createRequire(file)
    const specifiers = new Set()
    for (const pattern of SPECIFIER_PATTERNS) {
      for (const match of source.matchAll(pattern)) {
        specifiers.add(match[1])
      }
    }

    for (const spec of specifiers) {
      if (isBuiltin(spec) || spec.startsWith('node:') || spec === 'electron') continue
      if (ALLOWLIST.has(spec)) continue
      if (!isModuleSpecifier(spec)) continue
      // Nicht-Code-Assets (.css/.png/…) interessieren hier nicht
      if (/\.(css|png|svg|woff2?|map)$/.test(spec)) continue

      checked++
      let resolved
      try {
        resolved = fileRequire.resolve(spec)
      } catch (err) {
        console.error(`FAIL: "${spec}" nicht auflösbar`)
        console.error(`      benötigt von: ${relative(workDir, file)}`)
        console.error(`      ${err.message.split('\n')[0]}`)
        failures++
        continue
      }

      if (isBuiltin(resolved)) continue

      // Auflösung ausserhalb des Bundles = Dev-Baum-Leck, im DMG kaputt
      if (!resolved.startsWith(workDir)) {
        console.error(`FAIL: "${spec}" löst AUSSERHALB des Bundles auf: ${resolved}`)
        console.error(`      benötigt von: ${relative(workDir, file)}`)
        failures++
        continue
      }

      // Weiterverfolgen (nur JS, und node_modules nur eine Ebene tief pro Datei —
      // die BFS deckt Transitives über die Dateien selbst ab)
      if (/\.(js|mjs|cjs)$/.test(resolved) && statSync(resolved).isFile()) {
        queue.push(resolved)
      }
    }
  }

  console.log('')
  console.log(`${visited.size} Dateien traversiert, ${checked} Specifier aufgelöst.`)
  if (failures > 0) {
    console.error(`\nRESOLVE-GATE FAILED — ${failures} unauflösbare Specifier im gepackten Bundle.`)
    console.error('Die App würde auf dem betroffenen Feature-Pfad zur Laufzeit brechen.')
    process.exit(1)
  }
  console.log('RESOLVE-GATE OK — jeder Runtime-Specifier ist im Bundle auflösbar.')
} finally {
  rmSync(workDir, { recursive: true, force: true })
}
