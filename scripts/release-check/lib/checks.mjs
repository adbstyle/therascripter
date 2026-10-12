/**
 * Die Prüfungen der neuen Version (Issue #170). Jede liefert
 * { name, ok, detail }; eine Prüfung, die nicht durchführbar ist, zählt als
 * gescheitert (AK 7).
 */
import { deepStrictEqual } from 'assert'
import { readFileSync } from 'fs'
import {
  importPdf,
  listSessions,
  startRecording,
  stopRecording,
  waitUntilProcessed
} from './app-actions.mjs'
import { launchInstance, waitFor } from './instance.mjs'
import { SEED_SETTINGS_KEYS } from './seed.mjs'
import {
  FRESH_HOME,
  SEED_HOME,
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

/**
 * AK 2–4: Die neue Version startet auf dem Seed der Vorversion, zeigt alle
 * Sitzungen, behält alle Inhalte, verarbeitet die wartende Sitzung und
 * danach eine neue Aufnahme und ein PDF bis zur Zusammenfassung.
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
      const pending = await page.eval('window.api.modelUpdate.getPending()')
      if (pending?.length) throw new Error('App zeigt den Modell-Update-Bildschirm statt der Liste')
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
    try {
      log('Neues PDF wird verarbeitet …')
      const pdfId = await importPdf(page, fixtures.pdf)
      const pdf = await waitUntilProcessed(page, pdfId, { label: 'Neues PDF', timeoutMs: 600_000 })
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
  } finally {
    await app.quit().catch(() => app.kill())
  }
  return results
}
