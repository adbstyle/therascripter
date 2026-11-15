/**
 * Seed-Bestand (Issue #170, AK 9): Die zuletzt veröffentlichte Version legt
 * ihn über ihre eigene App an, damit er im Datenformat der Vorversion vorliegt.
 *
 * Inhalt:
 *   - Einstellungen (Theme, Review-Panel, Consent-Hinweis) und Sperrliste mit
 *     allen 7 Typen
 *   - eine Aufnahme und ein PDF, fertig verarbeitet («review») samt
 *     Zusammenfassung; die Aufnahme ist bearbeitet (Text, Sprecher)
 *   - «error» und «queued»: Aufnahme starten, währenddessen ein PDF
 *     importieren (es wartet, die Warteschlange pausiert während Aufnahmen),
 *     dann die App beenden — die Aufnahme endet als «error», das PDF wartet
 *
 *   - ab einer Vorversion mit Patientendossiers (Epic #192, erkannt an der
 *     Renderer-API, nicht an der Versionsnummer): ein Dossier mit beiden
 *     fertigen Sitzungen, ein Dokumentdatum am PDF, eine letzte
 *     Suchanfrage und «Zuletzt»-Einträge (Sitzung, Dossier). Ältere
 *     Vorversionen bekommen diesen Teil nicht; die Prüfung meldet seinen
 *     Erhalt dann als «nicht geprüft».
 *
 * Kein «recording»: Eine solche Sitzung löst beim Start einen nativen
 * Wiederherstellungs-Dialog aus, den die Prüfung nicht wegklicken kann.
 *
 * Ergebnis im Cache pro Tag: das Datenverzeichnis ohne Modelle, die
 * Einstellungen und expectations.json — was die neue Version unverändert
 * zeigen muss.
 */
import { execFileSync, spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { importPdf, listSessions, startRecording, waitUntilProcessed } from './app-actions.mjs'
import {
  FEATURES_EXPRESSION,
  SEED_DOCUMENT_DATE,
  SEED_DOSSIER,
  SEED_RECENT_QUERY,
  buildDossierSeedExpectations,
  supportsDossierSeed
} from './dossier-search.mjs'
import { launchInstance, prepareSandbox, toolEnv } from './instance.mjs'
import {
  BASE,
  SEED_HOME,
  cloneModels,
  dataDir,
  query,
  resetHome,
  settingsPath,
  writeModelSettings
} from './workspace.mjs'

/**
 * Vom Nutzer gesetzte Einstellungen, die exakt erhalten bleiben müssen. Nicht
 * activeModels: Eine neue Version darf aktive Modelle beim Start bewusst
 * ablösen (retireObsoleteModels, reconcileActiveModels) — dafür prüft
 * checks.mjs, dass jedes aktive Modell installiert ist.
 */
export const SEED_SETTINGS_KEYS = ['theme', 'reviewPanelOpen', 'consentReminderShown']

const BLOCKLIST = [
  ['Praxis Seefeld', 'ORGANISATION'],
  ['Dr. Keller', 'PERSON'],
  ['Kreuzlingen', 'ORT'],
  ['14.02.1987', 'DATUM'],
  ['079 555 12 34', 'KONTAKT'],
  ['Sertralin', 'MEDIZINISCH'],
  ['Projekt Nordlicht', 'SONSTIGES']
]

/**
 * Der Cache-Schlüssel enthält neben dem Tag einen Hash über den Seed-Aufbau
 * und die Testdaten: Kommt eine neue Datenart in den Seed (NFR 6), entsteht
 * ein neuer Seed, statt dass ein alter aus dem Cache sie still auslässt.
 */
function seedDir(tag, fixtures) {
  const here = dirname(fileURLToPath(import.meta.url))
  const hash = createHash('sha256')
  for (const file of [
    join(here, 'seed.mjs'),
    join(here, 'app-actions.mjs'),
    join(here, 'dossier-search.mjs'),
    fixtures.wav,
    fixtures.pdf
  ]) {
    hash.update(readFileSync(file))
  }
  return join(BASE, 'seeds', `${tag}-${hash.digest('hex').slice(0, 12)}`)
}

/**
 * Bearbeitung wie im Review-Editor: Text ergänzen, den ersten Sprecher
 * umbenennen (unabhängig von seiner ID). Beides muss stattfinden, sonst
 * prüfte die neue Version still eine unbearbeitete Sitzung.
 */
function editDocument(doc) {
  let textEdited = false
  let speaker = null
  const visit = (node) => {
    if (node.type === 'speakerLabel') {
      speaker ??= node.attrs?.speaker
      if (node.attrs?.speaker === speaker) node.attrs.label = 'Therapeutin'
    }
    if (!textEdited && node.type === 'text' && node.text?.trim()) {
      node.text = `${node.text} Im Seed ergänzt.`
      textEdited = true
    }
    for (const child of node.content ?? []) visit(child)
  }
  visit(doc)
  if (!textEdited) throw new Error('Seed: Transkript enthält keinen Text zum Bearbeiten')
  if (speaker == null) throw new Error('Seed: Transkript enthält keinen Sprecher zum Umbenennen')
  return doc
}

/** Seite des Test-PDFs, die nur als Bild vorliegt (build-fixtures.mjs). */
const SCAN_PAGE = 2
const WARM_UP_TIMEOUT_MS = 180_000

/**
 * Wärmt Apple Vision vor, bevor die Vorversion das Seed-PDF verarbeitet.
 *
 * Warum: Auf macOS 27 dauert der erste Vision-Aufruf ohne Cache 25–35 s
 * (Modell-Kompilierung für die Neural Engine, Cache unter
 * ~/Library/Caches/vision-ocr/com.apple.e5rt.e5bundlecache/<OS-Build>/),
 * jeder weitere ~0.25 s. Die Vorversionen haben ein Seiten-Timeout von 30 s
 * fest eingebaut — mit kaltem Cache scheiterte der Seed deterministisch
 * («OCR für Seite 2 abgebrochen: Timeout nach 30s»). Ab dem Fix hat die App
 * 120 s; die geprüfte NEUE Version braucht deshalb kein Vorwärmen, und eine
 * veröffentlichte Vorversion lässt sich nicht mehr ändern.
 *
 * Wo der Cache liegt: NICHT im Test-Home. Die App startet vision-ocr mit
 * ihrer Whitelist-Umgebung ohne CFFIXED_USER_HOME (siehe toolEnv), Vision legt
 * den Cache deshalb im echten Home des Benutzerkontos an — gemessen: ein Lauf
 * mit HOME=<frisches Verzeichnis> ohne CFFIXED_USER_HOME nutzt den warmen Cache
 * des echten Homes (0.36 s) und legt im frischen Verzeichnis nichts an; MIT
 * CFFIXED_USER_HOME entstünde ein eigener, kalter Cache im Test-Home, den der
 * spätere Aufruf aus der App nie liest. Das Vorwärmen startet vision-ocr
 * deshalb genau wie die App: dasselbe Binary (aus der Vorversion), dieselbe
 * Umgebung, dieselbe Sandbox. Weil der Cache im echten Home liegt, sind danach
 * auch die frischen Homes der übrigen Prüfungen warm. Dass dabei ein
 * Vision-Cache im echten Home entsteht, ist kein Bruch der Isolation: die
 * App tut während der Prüfung dasselbe, Nutzerdaten berührt es nicht.
 */
function warmUpVision({ appPath, home, pdf, scanWord, log }) {
  const bin = join(appPath, 'Contents', 'Resources', 'bin', 'vision-ocr')
  if (!existsSync(bin)) throw new Error(`Seed: vision-ocr fehlt in der Vorversion (${bin})`)
  const profilePath = prepareSandbox(home)
  const started = Date.now()
  const result = spawnSync(
    'sandbox-exec',
    ['-f', profilePath, bin, '--pdf', pdf, '--page', String(SCAN_PAGE)],
    {
      env: toolEnv(home),
      encoding: 'utf8',
      timeout: WARM_UP_TIMEOUT_MS,
      // sandbox-exec ersetzt sich per exec durch vision-ocr (gleiche PID):
      // SIGKILL beendet ein hängendes vision-ocr sicher
      killSignal: 'SIGKILL'
    }
  )
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  if (result.error || result.status !== 0) {
    const ended = result.signal ? `Signal ${result.signal}` : `Exit ${result.status}`
    const reason = result.error?.message ?? `${ended}: ${result.stderr?.slice(0, 300)}`
    throw new Error(`Seed: Vision-Vorwärmen nach ${seconds} s gescheitert — ${reason}`)
  }
  if (!result.stdout.includes(scanWord)) {
    throw new Error(`Seed: Vision-Vorwärmen erkannte «${scanWord}» auf Seite ${SCAN_PAGE} nicht`)
  }
  log(`Seed: Apple Vision vorgewärmt (${seconds} s)`)
}

/**
 * Baut den Seed mit der App `appPath` (Vorversion), falls er für `tag` noch
 * nicht im Cache liegt. Danach liegt er entpackt in SEED_HOME.
 */
export async function ensureSeed({ tag, appPath, fixtures, logFile, log }) {
  const dir = seedDir(tag, fixtures)
  if (existsSync(join(dir, 'expectations.json'))) {
    log(`Seed für ${tag} aus dem Cache`)
    return restoreSeed(dir)
  }

  log(`Baue Seed mit ${tag} (einmalig, dauert einige Minuten) …`)
  resetHome(SEED_HOME)
  cloneModels(SEED_HOME)
  writeModelSettings(SEED_HOME)

  warmUpVision({
    appPath,
    home: SEED_HOME,
    pdf: fixtures.pdf,
    scanWord: fixtures.pdfScanPageWord,
    log
  })

  const app = await launchInstance({ appPath, home: SEED_HOME, logFile, label: `Seed ${tag}` })
  const { page } = app
  let expectations
  try {
    await page.eval(`Promise.all([
      window.api.settings.set('theme', 'dark'),
      window.api.settings.set('reviewPanelOpen', true),
      window.api.settings.set('consentReminderShown', true)
    ])`)
    for (const [term, type] of BLOCKLIST) {
      await page.eval(`window.api.blocklist.add(${JSON.stringify(term)}, ${JSON.stringify(type)})`)
    }

    log('Seed: Aufnahme verarbeiten …')
    const audioId = await startRecording(page, fixtures.wav)
    await page.eval(`window.api.recording.stop(${JSON.stringify(audioId)})`)
    await waitUntilProcessed(page, audioId, { label: 'Seed-Aufnahme', timeoutMs: 600_000 })

    const loaded = await page.eval(`window.api.review.load(${JSON.stringify(audioId)})`)
    await page.eval(
      `window.api.review.save(${JSON.stringify(audioId)}, ${JSON.stringify(editDocument(loaded.document))}, ${JSON.stringify(loaded.entityMap)})`
    )

    log('Seed: PDF verarbeiten …')
    const pdfId = await importPdf(page, fixtures.pdf)
    await waitUntilProcessed(page, pdfId, { label: 'Seed-PDF', timeoutMs: 600_000 })

    const reviewIds = [audioId, pdfId]
    const reviews = {}
    for (const id of reviewIds) {
      reviews[id] = await page.eval(`window.api.review.load(${JSON.stringify(id)})`)
    }
    const sessions = await listSessions(page)
    const blocklist = await page.eval('window.api.blocklist.list()')

    const features = (await page.eval(FEATURES_EXPRESSION)) ?? {}
    let dossierId = null
    let recentQueries = null
    let dossier = null
    if (supportsDossierSeed(features)) {
      log('Seed: Patientendossier, Zuordnung, Dokumentdatum, Suchanfrage, «Zuletzt» …')
      dossierId = await seedDossierData(page, { audioId, pdfId })
      dossier = await page.eval(`window.api.dossiers.get(${JSON.stringify(dossierId)})`)
      recentQueries = await page.eval('window.api.search.recentList()')
    } else {
      log(`Seed: ${tag} kennt keine Patientendossiers — Seed ohne Dossier-Teil`)
    }

    log('Seed: wartende und abgebrochene Sitzung anlegen …')
    const interruptedId = await startRecording(page, fixtures.wav, { seconds: 3 })
    const queuedId = await importPdf(page, fixtures.pdf)

    expectations = {
      tag,
      reviewIds,
      interruptedId,
      queuedId,
      sessions: sessions.filter((s) => reviewIds.includes(s.id)),
      reviews,
      blocklist,
      dossierSeed: dossierId ? { dossier, recentQueries, audioId, pdfId } : null
    }
  } catch (err) {
    app.kill()
    throw err
  }
  await app.quit()

  // Zustände nach dem Beenden aus der Datenbank, nicht aus der App: «error»
  // und «queued» entstehen erst beim Beenden.
  const status = Object.fromEntries(
    query(SEED_HOME, 'SELECT id, status FROM sessions').map((r) => [r.id, r.status])
  )
  if (status[expectations.interruptedId] !== 'error') {
    throw new Error(
      `Seed: Abgebrochene Aufnahme ist «${status[expectations.interruptedId]}» statt «error»`
    )
  }
  const pending = query(
    SEED_HOME,
    `SELECT count(*) AS n FROM task_queue WHERE session_id = '${expectations.queuedId}' AND status IN ('pending', 'running')`
  )[0].n
  if (!['queued', 'processing'].includes(status[expectations.queuedId]) || pending === 0) {
    throw new Error(
      `Seed: Wartendes PDF ist «${status[expectations.queuedId]}» mit ${pending} offenen Aufgaben — Seed nochmals bauen`
    )
  }
  const settings = JSON.parse(readFileSync(settingsPath(SEED_HOME), 'utf8'))
  expectations.status = status
  expectations.taskCount = query(SEED_HOME, 'SELECT count(*) AS n FROM task_queue')[0].n
  expectations.settings = Object.fromEntries(SEED_SETTINGS_KEYS.map((k) => [k, settings[k]]))
  if (expectations.dossierSeed) {
    // Zuordnungen, Dokumentdatum und «Zuletzt» aus der Datenbank nach dem
    // Beenden — auch die abgebrochene Aufnahme legt einen «Zuletzt»-Eintrag an
    const { dossier, recentQueries, audioId, pdfId } = expectations.dossierSeed
    expectations.dossierSeed = buildDossierSeedExpectations({
      dossier,
      recentQueries,
      audioId,
      pdfId,
      assignments: query(
        SEED_HOME,
        'SELECT session_id, dossier_id, assigned_at FROM session_dossiers'
      ),
      documentDates: Object.fromEntries(
        query(
          SEED_HOME,
          'SELECT id, document_date FROM sessions WHERE document_date IS NOT NULL'
        ).map((r) => [r.id, r.document_date])
      ),
      recentItems: query(
        SEED_HOME,
        'SELECT dossier_id, session_id FROM recent_items ORDER BY opened_at DESC, id DESC'
      )
    })
  }

  // Ablegen: Datenverzeichnis ohne Modelle, Einstellungen, Erwartungen
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  execFileSync('tar', [
    '-czf',
    join(dir, 'data.tar.gz'),
    '--exclude',
    './models',
    '-C',
    dataDir(SEED_HOME),
    '.'
  ])
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings, null, 2))
  writeFileSync(join(dir, 'expectations.json'), JSON.stringify(expectations, null, 2))
  log(`Seed für ${tag} gespeichert (${dir})`)
  return restoreSeed(dir)
}

/**
 * Dossier-Teil des Seeds (Epic #192) über die reguläre Renderer-API: Dossier
 * anlegen, beide fertigen Sitzungen zuordnen, Dokumentdatum am PDF setzen,
 * eine Suchanfrage merken, Sitzung und Dossier «öffnen» (Zuletzt). Jede
 * Antwort wird geprüft — ein still gescheiterter Schritt ergäbe einen Seed,
 * der die Prüfung nichts mehr beweisen liesse.
 */
async function seedDossierData(page, { audioId, pdfId }) {
  const json = (value) => JSON.stringify(value)
  const created = await page.eval(`window.api.dossiers.create(${json(SEED_DOSSIER)})`)
  if (!created?.ok) throw new Error(`Seed: Dossier nicht angelegt — ${json(created)}`)
  const dossierId = created.dossier.id
  for (const id of [audioId, pdfId]) {
    const assigned = await page.eval(`window.api.dossiers.assign(${json(id)}, ${json(dossierId)})`)
    if (!assigned?.ok) throw new Error(`Seed: Zuordnung ${id} gescheitert — ${json(assigned)}`)
  }
  const dated = await page.eval(
    `window.api.sessions.setDocumentDate(${json(pdfId)}, ${json(SEED_DOCUMENT_DATE)})`
  )
  if (!dated?.ok) throw new Error(`Seed: Dokumentdatum nicht gesetzt — ${json(dated)}`)
  await page.eval(`window.api.search.recentRemember(${json(SEED_RECENT_QUERY)})`)
  await page.eval(`window.api.recent.touch(${json({ kind: 'session', id: audioId })})`)
  await page.eval(`window.api.recent.touch(${json({ kind: 'dossier', id: dossierId })})`)
  return dossierId
}

/** Entpackt den Seed nach SEED_HOME und klont die Modelle dazu. */
function restoreSeed(dir) {
  resetHome(SEED_HOME)
  mkdirSync(dataDir(SEED_HOME), { recursive: true })
  execFileSync('tar', ['-xzf', join(dir, 'data.tar.gz'), '-C', dataDir(SEED_HOME)])
  cloneModels(SEED_HOME)
  mkdirSync(join(settingsPath(SEED_HOME), '..'), { recursive: true })
  writeFileSync(settingsPath(SEED_HOME), readFileSync(join(dir, 'settings.json')))
  return JSON.parse(readFileSync(join(dir, 'expectations.json'), 'utf8'))
}
