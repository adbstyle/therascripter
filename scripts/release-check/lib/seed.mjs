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
 * Kein «recording»: Eine solche Sitzung löst beim Start einen nativen
 * Wiederherstellungs-Dialog aus, den die Prüfung nicht wegklicken kann.
 *
 * Ergebnis im Cache pro Tag: das Datenverzeichnis ohne Modelle, die
 * Einstellungen und expectations.json — was die neue Version unverändert
 * zeigen muss.
 */
import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { importPdf, listSessions, startRecording, waitUntilProcessed } from './app-actions.mjs'
import { launchInstance } from './instance.mjs'
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
      blocklist
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
