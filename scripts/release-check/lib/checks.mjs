/**
 * Die Prüfungen der neuen Version (Issue #170). Jede liefert
 * { name, ok, detail }; eine Prüfung, die nicht durchführbar ist, zählt als
 * gescheitert (AK 7).
 */
import { deepStrictEqual } from 'assert'
import { existsSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import {
  importPdf,
  listSessions,
  startRecording,
  stopRecording,
  waitUntilProcessed
} from './app-actions.mjs'
import {
  EXACT_PROBES,
  FEATURES_EXPRESSION,
  SEMANTIC_PROBE,
  compareDossierSeed,
  evaluateSearchModel,
  evaluateSemantic,
  searchModelDirFromCatalog,
  leftoverQueries,
  leftoversAfterDossierDelete,
  lifecycleDossier,
  missingInResults,
  skipped
} from './dossier-search.mjs'
import { launchInstance, waitFor } from './instance.mjs'
import { SEED_SETTINGS_KEYS } from './seed.mjs'
import {
  FRESH_HOME,
  SEED_HOME,
  dataDir,
  query,
  resetHome,
  settingsPath,
  shiftTimestampsToNow
} from './workspace.mjs'

const SESSION_FIELDS = [
  'title',
  'type',
  'status',
  'summary',
  'summaryModelId',
  'wordCount',
  'anonymizationCount',
  'entityMap'
]

function same(actual, expected) {
  try {
    deepStrictEqual(actual, expected)
    return null
  } catch (err) {
    return err.message.split('\n').slice(0, 12).join('\n')
  }
}

const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj?.[k]]))

/** AK 1: Ohne Daten startet die App bis zur Ersteinrichtung. */
export async function checkFreshStart({ appPath, logFile }) {
  resetHome(FRESH_HOME)
  const app = await launchInstance({
    appPath,
    home: FRESH_HOME,
    logFile,
    label: 'Start ohne Daten'
  })
  try {
    const status = await app.page.eval('window.api.modelDownload.status()')
    if (status.modelsReady) throw new Error('App meldet Modelle als bereit, obwohl keine da sind')
    await waitFor(
      () =>
        app.page.eval(
          `[...document.querySelectorAll('button')].some((b) => b.textContent.includes('Download starten'))`
        ),
      { what: 'Ersteinrichtung mit «Download starten»', timeoutMs: 20_000, intervalMs: 500 }
    )
    return [{ name: 'Start ohne Daten bis zur Ersteinrichtung', ok: true }]
  } finally {
    await app.quit().catch(() => app.kill())
  }
}

const json = (value) => JSON.stringify(value)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let requestId = 0
const search = (page, query, scope = { kind: 'all' }) =>
  page.eval(`window.api.search.query(${json({ requestId: ++requestId, query, scope })})`)

/**
 * Epic #192: Dossier-Teil des Seeds erhalten — nur wenn die Vorversion ihn
 * anlegen konnte. Zuordnungen, Dokumentdatum und «Zuletzt» direkt aus der
 * Datenbank (lesend), Dossier und Suchanfragen über die App.
 */
async function checkDossierSeed(page, expectations, record, results) {
  const expected = expectations.dossierSeed
  if (!expected) {
    results.push(
      skipped(
        'Patientendossiers und Suchdaten der Vorversion erhalten',
        `Vorversion ${expectations.tag} kennt keine Patientendossiers`
      )
    )
    return
  }
  const actual = {
    dossier: await page.eval(`window.api.dossiers.get(${json(expected.dossier.id)})`),
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
    recentQueries: await page.eval('window.api.search.recentList()'),
    recentItems: query(
      SEED_HOME,
      'SELECT dossier_id, session_id FROM recent_items ORDER BY opened_at DESC, id DESC'
    )
  }
  for (const { name, error } of compareDossierSeed(expected, actual)) record(name, error)
}

/**
 * Epic #192 (#210 AK 1): Die Bestandssitzungen werden nach dem Update ohne
 * Zutun durchsuchbar — exakt immer; nach Bedeutung nur, wenn das Suchmodell
 * auf dem Release-Mac installiert ist (sonst «nicht geprüft», nie grün).
 */
async function checkSearchOfSeed(page, expectations, record, results, log) {
  const [audioId, pdfId] = expectations.reviewIds
  const idFor = { audio: audioId, pdf: pdfId }

  log('Exakte Suche über die Sitzungen der Vorversion …')
  const missing = new Map(EXACT_PROBES.map((p) => [p.query, [idFor[p.seed]]]))
  const deadline = Date.now() + 120_000
  while (missing.size > 0 && Date.now() < deadline) {
    for (const [q, ids] of missing) {
      if (missingInResults(await search(page, q), ids).length === 0) missing.delete(q)
    }
    if (missing.size > 0) await sleep(3000)
  }
  for (const probe of EXACT_PROBES) {
    record(
      `Exakte Suche «${probe.query}» findet die Sitzung der Vorversion (${probe.seed === 'pdf' ? 'PDF' : 'Aufnahme'})`,
      missing.has(probe.query) ? 'Nach 120 s nicht gefunden — Bestand nicht indexiert' : null
    )
  }

  const name = `Suche nach Bedeutung «${SEMANTIC_PROBE}» findet die Sitzung der Vorversion`
  // «Installiert» vom Datenträger, nicht aus dem Status: ein vorhandenes, aber
  // kaputtes Modell muss rot werden, nicht «nicht geprüft» (Review PR #234)
  const installed = existsSync(join(dataDir(SEED_HOME), 'models', searchModelDir()))
  let model = evaluateSearchModel({ installed, availability: null })
  if (model.state === 'skipped') {
    results.push(skipped(name, model.detail))
    return
  }
  log('Suchmodell liegt auf dem Datenträger — warte, bis es bereit ist …')
  const modelDeadline = Date.now() + 180_000
  for (;;) {
    model = evaluateSearchModel({
      installed,
      availability: await page.eval('window.api.search.open()')
    })
    if (model.state !== 'waiting' || Date.now() > modelDeadline) break
    await sleep(5000)
  }
  if (model.state !== 'ok') {
    record(
      name,
      model.state === 'waiting'
        ? `Suchmodell liegt auf dem Datenträger, wird aber nach 180 s nicht bereit (${model.detail})`
        : model.detail
    )
    return
  }

  log('Suche nach Bedeutung (wartet auf die Vektoren) …')
  let verdict = evaluateSemantic({ result: null, sessionId: pdfId })
  const semanticDeadline = Date.now() + 300_000
  while (verdict.state === 'waiting' && Date.now() < semanticDeadline) {
    const result = await page.eval(
      `window.api.search.semantic(${json({ requestId: ++requestId, query: SEMANTIC_PROBE, scope: { kind: 'all' } })})`,
      { timeoutMs: 120_000 }
    )
    verdict = evaluateSemantic({ result, sessionId: pdfId })
    if (verdict.state === 'waiting') await sleep(5000)
  }
  record(
    name,
    verdict.state === 'ok'
      ? null
      : verdict.state === 'waiting'
        ? `Nach 300 s kein Treffer nach Bedeutung (${verdict.detail})`
        : verdict.detail,
    verdict.detail
  )
}

/** Ordner des Suchmodells laut Katalog dieses Checkouts (siehe searchModelDirFromCatalog). */
function searchModelDir() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  return searchModelDirFromCatalog(
    readFileSync(join(root, 'src', 'shared', 'model-catalog.ts'), 'utf8')
  )
}

/**
 * Epic #192 (#204, #205, #207): In der neuen Version ein Dossier anlegen,
 * eine Sitzung zuordnen, sie im Verlauf sehen, das Dossier samt dieser
 * (exklusiven) Sitzung löschen — danach ist beides nirgends mehr auffindbar:
 * nicht in der Liste, nicht in der Suche, keine Zeile in der Datenbank.
 */
async function checkDossierLifecycle(page, sessionId, record, log) {
  const name = 'Neues Dossier: anlegen, zuordnen, Verlauf, mit exklusiver Sitzung löschen'
  log('Dossier anlegen, zuordnen, löschen …')
  const input = lifecycleDossier(Date.now().toString(36))
  const created = await page.eval(`window.api.dossiers.create(${json(input)})`)
  if (!created?.ok) return record(name, `Anlegen gescheitert: ${json(created)}`)
  const dossierId = created.dossier.id

  const assigned = await page.eval(
    `window.api.dossiers.assign(${json(sessionId)}, ${json(dossierId)})`
  )
  if (!assigned?.ok) return record(name, `Zuordnen gescheitert: ${json(assigned)}`)

  const timeline = await page.eval(`window.api.dossiers.timeline(${json(dossierId)})`)
  if (!timeline.some((e) => e.id === sessionId)) {
    return record(name, 'Zugeordnete Sitzung fehlt im Verlauf des Dossiers')
  }
  const found = await waitFor(
    async () => {
      const r = await search(page, input.lastName)
      return r.dossiers.some((d) => d.id === dossierId) ? r : null
    },
    { what: 'Neues Dossier in der Suche', timeoutMs: 30_000, intervalMs: 1000 }
  ).catch(() => null)
  if (!found) return record(name, 'Neues Dossier wird von der Suche nicht gefunden')

  const preview = await page.eval(`window.api.dossiers.deletePreview(${json(dossierId)})`)
  if (preview?.exclusive?.sessions + preview?.exclusive?.pdfs !== 1) {
    return record(
      name,
      `Löschvorschau nennt nicht genau die eine Sitzung: ${json(preview?.exclusive)}`
    )
  }
  const deleted = await page.eval(
    `window.api.dossiers.delete(${json(dossierId)}, ${json(preview.fingerprint)})`
  )
  if (!deleted?.ok || !deleted.deletedSessionIds.includes(sessionId)) {
    return record(name, `Löschen gescheitert: ${json(deleted)}`)
  }

  // Die Indexzeilen entfernt die Suche gestaffelt (Sekunden), deshalb mit Frist
  const sql = leftoverQueries(dossierId, sessionId)
  let left = []
  const deadline = Date.now() + 60_000
  do {
    if (left.length) await sleep(2000)
    left = leftoversAfterDossierDelete({
      dossierId,
      sessionId,
      state: {
        listedSessionIds: (await listSessions(page)).map((s) => s.id),
        dossierSearch: await search(page, input.lastName),
        contentSearch: await search(page, EXACT_PROBES[0].query),
        dbCounts: Object.fromEntries(
          Object.entries(sql).map(([table, q]) => [table, query(SEED_HOME, q)[0].n])
        )
      }
    })
  } while (left.length && Date.now() < deadline)
  record(name, left.length ? `Nach 60 s noch auffindbar: ${left.join(', ')}` : null)
}

/**
 * AK 2–4: Die neue Version startet auf dem Seed der Vorversion, zeigt alle
 * Sitzungen, behält alle Inhalte, verarbeitet die wartende Sitzung und
 * danach eine neue Aufnahme und ein PDF bis zur Zusammenfassung. Epic #192:
 * Dossier-Teil des Seeds erhalten, Bestand durchsuchbar, Dossier-Lebenszyklus.
 */
export async function checkSeededRun({ appPath, logFile, expectations, fixtures, log }) {
  shiftTimestampsToNow(SEED_HOME)
  const results = []
  const record = (name, error, detail) =>
    results.push({ name, ok: !error, detail: error ?? detail })
  const expectedIds = Object.keys(expectations.status)

  const app = await launchInstance({ appPath, home: SEED_HOME, logFile, label: 'Start mit Seed' })
  const { page } = app
  try {
    // ── AK 2: bedienbare Transkriptionsliste mit allen Sitzungen ────────────
    try {
      const status = await page.eval('window.api.modelDownload.status()')
      if (!status.modelsReady)
        throw new Error('App verlangt die Ersteinrichtung (Modelle nicht erkannt)')
      const shown = await waitFor(
        () =>
          page.eval(`(() => {
            const title = [...document.querySelectorAll('main h2')].some((h) => h.textContent === 'Transkriptionen')
            const ids = [...document.querySelectorAll('[data-session-id]')].map((e) => e.dataset.sessionId)
            return title && ids.length >= ${expectedIds.length} ? ids : null
          })()`),
        {
          what: 'Transkriptionsliste mit allen Seed-Sitzungen',
          timeoutMs: 60_000,
          intervalMs: 1000
        }
      )
      const missing = expectedIds.filter((id) => !shown.includes(id))
      record(
        'Transkriptionsliste zeigt alle Sitzungen der Vorversion',
        missing.length ? `Fehlt in der Liste: ${missing.join(', ')}` : null,
        `${shown.length} Sitzungen`
      )
    } catch (err) {
      record('Transkriptionsliste zeigt alle Sitzungen der Vorversion', err.message)
    }

    // ── AK 3: Inhalte erhalten ─────────────────────────────────────────────
    try {
      const sessions = await listSessions(page)
      const byId = Object.fromEntries(sessions.map((s) => [s.id, s]))
      for (const expected of expectations.sessions) {
        const actual = byId[expected.id]
        record(
          `Sitzung «${expected.title}»: Status, Zusammenfassung, Platzhalter-Zuordnung`,
          actual
            ? same(pick(actual, SESSION_FIELDS), pick(expected, SESSION_FIELDS))
            : 'Sitzung fehlt'
        )
        if (!actual) continue
        const review = await page.eval(`window.api.review.load(${JSON.stringify(expected.id)})`)
        const before = expectations.reviews[expected.id]
        record(
          `Sitzung «${expected.title}»: Transkript samt Bearbeitungen und Sprechern`,
          same(
            { document: review.document, entityMap: review.entityMap },
            {
              document: before.document,
              entityMap: before.entityMap
            }
          )
        )
      }
      const interrupted = byId[expectations.interruptedId]
      record(
        'Abgebrochene Aufnahme bleibt im Fehlerzustand',
        interrupted?.status === 'error' ? null : `Status «${interrupted?.status ?? 'fehlt'}»`
      )

      const blocklist = await page.eval('window.api.blocklist.list()')
      const norm = (list) => list.map((e) => `${e.placeholderType}:${e.term}`).sort()
      record('Sperrliste erhalten', same(norm(blocklist), norm(expectations.blocklist)))

      const notInstalled = []
      for (const group of ['asr', 'diarization', 'ner', 'summarization']) {
        const entries = await page.eval(`window.api.modelCatalog.list(${JSON.stringify(group)})`)
        const active = entries.find((e) => e.isActive)
        if (!active || !active.isInstalled)
          notInstalled.push(`${group}: ${active?.id ?? 'keins aktiv'}`)
      }
      record(
        'Jedes aktive Modell ist installiert',
        notInstalled.length ? notInstalled.join(', ') : null
      )

      const settings = JSON.parse(readFileSync(settingsPath(SEED_HOME), 'utf8'))
      record(
        'Einstellungen erhalten',
        same(pick(settings, SEED_SETTINGS_KEYS), expectations.settings)
      )
      const taskCount = query(SEED_HOME, 'SELECT count(*) AS n FROM task_queue')[0].n
      record(
        'Verarbeitungsverlauf (Aufgaben) erhalten',
        taskCount >= expectations.taskCount
          ? null
          : `${taskCount} statt mindestens ${expectations.taskCount} Aufgaben`
      )
    } catch (err) {
      record('Inhalte der Vorversion erhalten', `nicht durchführbar: ${err.message}`)
    }

    // ── Epic #192: Dossier-Teil des Seeds erhalten (vor jeder neuen Handlung,
    // die «Zuletzt» verändert) ──────────────────────────────────────────────
    try {
      await checkDossierSeed(page, expectations, record, results)
    } catch (err) {
      record(
        'Patientendossiers und Suchdaten der Vorversion erhalten',
        `nicht durchführbar: ${err.message}`
      )
    }

    // ── Wartende Sitzung läuft nach dem Start weiter ──────────────────────
    try {
      log('Wartende Sitzung der Vorversion wird verarbeitet …')
      await waitUntilProcessed(page, expectations.queuedId, {
        label: 'Wartendes PDF',
        timeoutMs: 600_000
      })
      record('Wartende Sitzung der Vorversion läuft bis zur Zusammenfassung', null)
    } catch (err) {
      record('Wartende Sitzung der Vorversion läuft bis zur Zusammenfassung', err.message)
    }

    // ── Epic #192: Bestand durchsuchbar (nach der wartenden Sitzung: die
    // Vektoren warten, solange eine Verarbeitung ansteht) ────────────────────
    try {
      const features = await page.eval(FEATURES_EXPRESSION)
      if (!features?.search) throw new Error('Die App hat keine Suche (window.api.search)')
      await checkSearchOfSeed(page, expectations, record, results, log)
    } catch (err) {
      record('Bestand der Vorversion durchsuchbar', `nicht durchführbar: ${err.message}`)
    }

    // ── AK 4: neue Aufnahme und neues PDF ──────────────────────────────────
    try {
      log('Neue Aufnahme wird verarbeitet …')
      const audioId = await startRecording(page, fixtures.wav)
      await stopRecording(page, audioId)
      const audio = await waitUntilProcessed(page, audioId, {
        label: 'Neue Aufnahme',
        timeoutMs: 600_000
      })
      record(
        'Kurze Aufnahme bis zur Zusammenfassung',
        null,
        `${audio.anonymizationCount} Platzhalter`
      )
    } catch (err) {
      record('Kurze Aufnahme bis zur Zusammenfassung', err.message)
    }
    let newPdfId = null
    try {
      log('Neues PDF wird verarbeitet …')
      const pdfId = await importPdf(page, fixtures.pdf)
      const pdf = await waitUntilProcessed(page, pdfId, { label: 'Neues PDF', timeoutMs: 600_000 })
      newPdfId = pdfId
      // Nicht pdfHasScannedPages: das meint «überwiegend gescannt» und ist
      // bei einem gemischten PDF korrekt false. Beweis für die Texterkennung
      // ist der Text der eingescannten Seite im Ergebnis.
      const review = await page.eval(`window.api.review.load(${JSON.stringify(pdfId)})`)
      const text = JSON.stringify(review.document)
      const missing = [fixtures.pdfTextPageWord, fixtures.pdfScanPageWord].filter(
        (word) => !text.includes(word)
      )
      record(
        'PDF mit Text- und eingescannter Seite bis zur Zusammenfassung',
        missing.length ? `Text fehlt im Ergebnis: ${missing.join(', ')}` : null,
        `${pdf.wordCount} Wörter`
      )
    } catch (err) {
      record('PDF mit Text- und eingescannter Seite bis zur Zusammenfassung', err.message)
    }

    // ── Epic #192: Dossier-Lebenszyklus mit dem neuen PDF ───────────────────
    const lifecycle = 'Neues Dossier: anlegen, zuordnen, Verlauf, mit exklusiver Sitzung löschen'
    try {
      if (!newPdfId) throw new Error('kein fertig verarbeitetes neues PDF (siehe oben)')
      await checkDossierLifecycle(page, newPdfId, record, log)
    } catch (err) {
      record(lifecycle, `nicht durchführbar: ${err.message}`)
    }
  } finally {
    await app.quit().catch(() => app.kill())
  }
  return results
}
