/**
 * Patientendossiers und Suche in der Release-Prüfung (Epic #192).
 *
 * Nur reine Funktionen und Konstanten — kein App-Start, kein Dateisystem —,
 * damit Seed-Aufbau und Auswertung ohne gepackte App getestet werden können
 * (src/main/__tests__/release-check-dossier-search.test.ts). Die Handlungen
 * selbst stehen in seed.mjs und checks.mjs.
 *
 * Versionsabhängig: Was die Vorversion an Dossier- und Suchdaten anlegen kann,
 * erkennt der Seed an ihrer Renderer-API (`dossierFeatures`), nicht an der
 * Versionsnummer. Kennt die Vorversion keine Dossiers (alles vor Epic #192),
 * enthält der Seed keine, und die Prüfung meldet die Erhaltungsprüfung als
 * «nicht geprüft».
 */

/**
 * Ein Ergebnis, das weder grün noch rot ist: die Prüfung war nicht möglich,
 * ohne dass etwas falsch ist (Suchmodell nicht installiert, Vorversion ohne
 * Dossiers). Zählt nie als bestanden und blockiert den Release nicht.
 */
export const skipped = (name, detail) => ({ name, ok: true, skipped: true, detail })

/** Ausdruck für page.eval: welche Dossier- und Such-API die laufende App hat. */
export const FEATURES_EXPRESSION = `({
  dossiers: typeof window.api.dossiers === 'object' && window.api.dossiers !== null,
  search: typeof window.api.search === 'object' && window.api.search !== null,
  recent: typeof window.api.recent === 'object' && window.api.recent !== null,
  documentDate: typeof window.api.sessions?.setDocumentDate === 'function'
})`

/** Kann diese App Dossier, Zuordnung, Dokumentdatum, Suchanfrage und «Zuletzt» anlegen? */
export function supportsDossierSeed(features) {
  return Boolean(
    features?.dossiers && features?.search && features?.recent && features?.documentDate
  )
}

/** Erfundene Angaben (NFR 2: keine echten Patientendaten). */
export const SEED_DOSSIER = {
  firstName: 'Daniel',
  lastName: 'Brunner',
  externalId: 'RC-SEED-001',
  birthDate: '1981-06-14'
}
/** Dokumentdatum des Seed-PDFs — weit weg vom Importtag, damit es sichtbar wirkt. */
export const SEED_DOCUMENT_DATE = '2024-03-15'
/** Letzte Suchanfrage im Seed. */
export const SEED_RECENT_QUERY = 'Schlaftagebuch'

/**
 * Exakte Suche über Bestandssitzungen (#210 AK 1: ohne Zutun durchsuchbar).
 * Je Anfrage die Seed-Sitzung, die sie finden muss:
 *   - pdf: Überschrift der Textseite (build-fixtures.mjs)
 *   - audio: der im Seed nachträglich ergänzte Text (seed.mjs editDocument) —
 *     beweist, dass die Bearbeitung indexiert ist, nicht nur das Original
 */
export const EXACT_PROBES = [
  { query: 'Verlaufsbericht', seed: 'pdf' },
  { query: 'Im Seed ergänzt', seed: 'audio' }
]

/**
 * Suche nach Bedeutung: eine Umschreibung ohne gemeinsames Wort mit dem
 * Seed-PDF («Erschöpfung seit dem Stellenwechsel») — die exakte Suche findet
 * sie nicht, ein Treffer kann also nur aus den Vektoren kommen.
 */
export const SEMANTIC_PROBE = 'Müdigkeit wegen der neuen Stelle'

/** Dossier, das die Prüfung der neuen Version anlegt und wieder löscht. */
export function lifecycleDossier(stamp) {
  return {
    firstName: 'Prüfung',
    lastName: 'Löschtest',
    externalId: `RC-DEL-${stamp}`,
    birthDate: '1990-01-01'
  }
}

/**
 * Was die neue Version vom Dossier-Teil des Seeds unverändert zeigen muss.
 * `raw` sind die beim Seed-Aufbau gelesenen Werte; fehlt etwas, das der Seed
 * angelegt haben soll, bricht der Aufbau ab — sonst prüfte die Prüfung später
 * still einen unvollständigen Seed.
 */
export function buildDossierSeedExpectations(raw) {
  const { dossier, assignments, documentDates, recentQueries, recentItems, pdfId, audioId } = raw
  if (!dossier?.id) throw new Error('Seed: Dossier wurde nicht angelegt')
  for (const key of Object.keys(SEED_DOSSIER)) {
    if (dossier[key] !== SEED_DOSSIER[key]) {
      throw new Error(
        `Seed: Dossier-Feld ${key} ist «${dossier[key]}» statt «${SEED_DOSSIER[key]}»`
      )
    }
  }
  const assigned = new Set(
    (assignments ?? []).filter((a) => a.dossier_id === dossier.id).map((a) => a.session_id)
  )
  for (const id of [pdfId, audioId]) {
    if (!assigned.has(id)) throw new Error(`Seed: Sitzung ${id} ist dem Dossier nicht zugeordnet`)
  }
  if (documentDates?.[pdfId] !== SEED_DOCUMENT_DATE) {
    throw new Error(
      `Seed: Dokumentdatum des PDFs ist «${documentDates?.[pdfId]}» statt «${SEED_DOCUMENT_DATE}»`
    )
  }
  if (!(recentQueries ?? []).some((q) => q.query === SEED_RECENT_QUERY)) {
    throw new Error(`Seed: Suchanfrage «${SEED_RECENT_QUERY}» nicht gemerkt`)
  }
  if (!(recentItems ?? []).some((r) => r.dossier_id === dossier.id)) {
    throw new Error('Seed: Dossier fehlt in «Zuletzt»')
  }
  return {
    dossier,
    assignments: normalizeAssignments(assignments),
    documentDates,
    recentQueries,
    recentItems: recentItems.map(recentKey)
  }
}

const normalizeAssignments = (rows) =>
  (rows ?? []).map((r) => `${r.session_id}|${r.dossier_id}|${r.assigned_at}`).sort()

const recentKey = (row) =>
  row.dossier_id ? `dossier:${row.dossier_id}` : `session:${row.session_id}`

/** Ist `sub` in derselben Reihenfolge in `list` enthalten (nicht unbedingt am Stück)? */
function inOrder(sub, list) {
  let i = 0
  for (const item of list) if (item === sub[i]) i++
  return i === sub.length
}

/**
 * Vergleicht den Dossier-Teil des Seeds mit dem, was die neue Version zeigt.
 * `actual`: { dossier (dossiers.get), assignments (Zeilen aus session_dossiers),
 * documentDates ({id: document_date}), recentQueries (search.recentList),
 * recentItems (Zeilen aus recent_items, neueste zuerst) }.
 * Liefert [{ name, error }] — error null heisst erhalten.
 */
export function compareDossierSeed(expected, actual) {
  const results = []
  const add = (name, error) => results.push({ name, error: error ?? null })

  const fields = Object.keys(expected.dossier)
  const changed = fields.filter(
    (k) => JSON.stringify(actual.dossier?.[k]) !== JSON.stringify(expected.dossier[k])
  )
  add(
    'Patientendossier der Vorversion erhalten (alle Angaben)',
    !actual.dossier ? 'Dossier fehlt' : changed.length ? `Geändert: ${changed.join(', ')}` : null
  )

  const now = normalizeAssignments(actual.assignments)
  const lost = expected.assignments.filter((a) => !now.includes(a))
  add(
    'Zuordnungen der Vorversion erhalten',
    lost.length ? `Fehlt oder geändert: ${lost.join(', ')}` : null
  )

  const dates = Object.entries(expected.documentDates ?? {}).filter(
    ([id, date]) => (actual.documentDates ?? {})[id] !== date
  )
  add(
    'Dokumentdatum der Vorversion erhalten',
    dates.length
      ? dates
          .map(([id, date]) => `${id}: «${actual.documentDates?.[id]}» statt «${date}»`)
          .join(', ')
      : null
  )

  const queries = (list) => (list ?? []).map((q) => `${q.query}|${q.usedAt}`)
  const missingQueries = queries(expected.recentQueries).filter(
    (q) => !queries(actual.recentQueries).includes(q)
  )
  add(
    'Letzte Suchanfragen der Vorversion erhalten',
    missingQueries.length ? `Fehlt: ${missingQueries.join(', ')}` : null
  )

  const nowRecent = (actual.recentItems ?? []).map(recentKey)
  add(
    '«Zuletzt»-Einträge der Vorversion erhalten (Reihenfolge)',
    inOrder(expected.recentItems, nowRecent)
      ? null
      : `Erwartet in dieser Reihenfolge ${expected.recentItems.join(', ')}, vorhanden ${nowRecent.join(', ') || 'keine'}`
  )
  return results
}

/**
 * Exakte Suche: Welche der erwarteten Sitzungen fehlen im Ergebnis?
 * `result` ist ein SearchQueryResult.
 */
export function missingInResults(result, sessionIds) {
  const found = new Set((result?.results ?? []).map((r) => r.sessionId))
  return sessionIds.filter((id) => !found.has(id))
}

/**
 * Suche nach Bedeutung.
 *   - skipped: Suchmodell nicht installiert (nie grün, nie rot)
 *   - waiting: noch keine Antwort mit Vektoren (Prozess lädt, Vektoren
 *     entstehen, Verarbeitung läuft) — weiter abfragen
 *   - ok: ein Treffer nach Bedeutung in der erwarteten Sitzung
 *   - fail: Antwort vollständig, aber ohne diesen Treffer; oder Suchprozess
 *     blockiert bzw. im Fehler
 * `availability` ist ein SearchAvailability, `result` ein SearchQueryResult
 * von search:semantic (oder null, solange nicht gefragt).
 */
export function evaluateSemantic({ availability, result, sessionId }) {
  const model = availability?.model?.status
  if (model !== 'ready') {
    return { state: 'skipped', detail: `Suchmodell nicht installiert (${model ?? 'unbekannt'})` }
  }
  if (availability.semantic === 'tool-blocked') {
    return { state: 'fail', detail: availability.semanticMessage ?? 'Python-Werkzeug blockiert' }
  }
  if (!result) return { state: 'waiting', detail: `Suche nach Bedeutung: ${availability.semantic}` }
  if (result.semantic === 'tool-blocked') {
    return { state: 'fail', detail: 'Python-Werkzeug blockiert' }
  }
  if (result.semantic !== 'complete') {
    return { state: 'waiting', detail: `Antwort «${result.semantic}»` }
  }
  const doc = (result.results ?? []).find((r) => r.sessionId === sessionId)
  const semanticHit = doc?.hits?.some((h) => h.kind === 'semantic')
  if (semanticHit) return { state: 'ok', detail: `${doc.hits.length} Fundstellen` }
  // «complete» ohne Treffer: die Vektoren der Sitzung können noch fehlen —
  // der Aufrufer fragt bis zu seiner Frist weiter und meldet dann rot.
  return {
    state: 'waiting',
    detail: doc
      ? 'Sitzung nur exakt getroffen, nicht nach Bedeutung'
      : 'Sitzung nicht unter den Treffern'
  }
}

/**
 * Nach dem Löschen eines Dossiers samt exklusiver Sitzung: Was ist noch
 * auffindbar? `state`: { listedSessionIds (sessions.list), dossierSearch
 * (search.query nach dem Namen), contentSearch (search.query nach einem Wort
 * der Sitzung), dbCounts ({Tabelle: Zeilen}) }. Liefert die Funde; leer
 * heisst vollständig weg.
 */
export function leftoversAfterDossierDelete({ dossierId, sessionId, state }) {
  const left = []
  if ((state.listedSessionIds ?? []).includes(sessionId)) left.push('Sitzung in der Liste')
  if ((state.dossierSearch?.dossiers ?? []).some((d) => d.id === dossierId)) {
    left.push('Dossier in der Suche')
  }
  if ((state.dossierSearch?.results ?? []).some((r) => r.sessionId === sessionId)) {
    left.push('Sitzung in der Suche nach dem Dossiernamen')
  }
  if ((state.contentSearch?.results ?? []).some((r) => r.sessionId === sessionId)) {
    left.push('Sitzung in der Suche nach ihrem Inhalt')
  }
  for (const [table, n] of Object.entries(state.dbCounts ?? {})) {
    if (n > 0) left.push(`${n} Zeile(n) in ${table}`)
  }
  return left
}

/** SQL für leftoversAfterDossierDelete (IDs aus der App, nur [0-9a-zA-Z-]). */
export function leftoverQueries(dossierId, sessionId) {
  for (const id of [dossierId, sessionId]) {
    if (!/^[0-9A-Za-z-]+$/.test(id)) throw new Error(`Unerwartete ID: ${id}`)
  }
  return {
    sessions: `SELECT count(*) AS n FROM sessions WHERE id = '${sessionId}'`,
    dossiers: `SELECT count(*) AS n FROM dossiers WHERE id = '${dossierId}'`,
    session_dossiers: `SELECT count(*) AS n FROM session_dossiers WHERE dossier_id = '${dossierId}' OR session_id = '${sessionId}'`,
    recent_items: `SELECT count(*) AS n FROM recent_items WHERE dossier_id = '${dossierId}' OR session_id = '${sessionId}'`,
    search_chunks: `SELECT count(*) AS n FROM search_chunks WHERE session_id = '${sessionId}'`,
    search_index_state: `SELECT count(*) AS n FROM search_index_state WHERE session_id = '${sessionId}'`
  }
}

/** Zusammenfassung für den Bericht: grün, rot, nicht geprüft. */
export function summarize(results) {
  const failed = results.filter((r) => !r.ok)
  const notChecked = results.filter((r) => r.ok && r.skipped)
  const passed = results.filter((r) => r.ok && !r.skipped)
  return { failed, notChecked, passed }
}

/** Zeichen vor einem Ergebnis im Bericht. */
export const marker = (r) => (!r.ok ? '✗' : r.skipped ? '–' : '✓')
