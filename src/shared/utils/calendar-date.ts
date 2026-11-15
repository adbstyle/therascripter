/**
 * Kalenderdaten ohne Uhrzeit (Geburtsdatum #204 AK 8, Dokumentdatum #205).
 *
 * Gespeichert und über IPC übertragen wird immer der ISO-Tag `YYYY-MM-DD`;
 * angezeigt und eingegeben wird `TT.MM.JJJJ`. «Heute» ist immer der Tag in
 * der lokalen Zeitzone des Macs — ein Datum, das in Zürich schon heute ist,
 * darf nicht abgelehnt werden, nur weil es in UTC noch gestern ist.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const SWISS_DATE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0')
}

function isRealDate(year: number, month: number, day: number): boolean {
  if (year < 1 || month < 1 || month > 12 || day < 1) return false
  // Tag 0 des Folgemonats = letzter Tag des Monats (inkl. Schaltjahr).
  // setUTCFullYear statt Date.UTC: Date.UTC deutet die Jahre 0–99 als 1900–1999.
  const lastDay = new Date(0)
  lastDay.setUTCFullYear(year, month, 0)
  return day <= lastDay.getUTCDate()
}

/** `YYYY-MM-DD` eines realen Kalendertags (31.04. und 29.02. ausserhalb von Schaltjahren: false). */
export function isValidIsoDate(iso: string): boolean {
  const match = ISO_DATE.exec(iso)
  if (!match) return false
  return isRealDate(Number(match[1]), Number(match[2]), Number(match[3]))
}

/**
 * Frühestes Jahr für Geburts- und Dokumentdatum: schützt vor Tippfehlern wie
 * «03.02.0978» oder «02.11.26» → Jahr 0026 (Epic #192, Review #223).
 */
export const MIN_CALENDAR_YEAR = 1900
const MIN_ISO_DATE = `${MIN_CALENDAR_YEAR}-01-01`

/** Meldung für ein Datum vor MIN_CALENDAR_YEAR — Renderer und Main sagen dasselbe. */
export const BEFORE_MIN_YEAR_MESSAGE = `Bitte ein Datum ab ${MIN_CALENDAR_YEAR} eingeben.`

/** true für einen gültigen ISO-Tag vor MIN_CALENDAR_YEAR (für die passende Meldung). */
export function isBeforeMinYear(iso: string): boolean {
  return isValidIsoDate(iso) && iso < MIN_ISO_DATE
}

/**
 * Gültiger ISO-Tag ab MIN_CALENDAR_YEAR, der nicht nach `todayIso` liegt
 * (ISO-Tage sind lexikografisch sortierbar).
 */
export function isValidIsoDateNotAfter(iso: string, todayIso: string): boolean {
  return isValidIsoDate(iso) && iso >= MIN_ISO_DATE && iso <= todayIso
}

/** Heutiger Tag in der lokalen Zeitzone als `YYYY-MM-DD`. */
export function localTodayIso(now: Date = new Date()): string {
  return `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * `TT.MM.JJJJ` (Tag und Monat auch einstellig) → `YYYY-MM-DD`, oder null, wenn
 * die Eingabe unvollständig oder kein realer Kalendertag ist. Prüft NICHT, ob
 * das Datum in der Zukunft liegt — dafür `isValidIsoDateNotAfter`.
 */
export function parseSwissDate(input: string): string | null {
  const match = SWISS_DATE.exec(input.trim())
  if (!match) return null
  const day = Number(match[1])
  const month = Number(match[2])
  const year = Number(match[3])
  if (!isRealDate(year, month, day)) return null
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`
}

/** `YYYY-MM-DD` → `TT.MM.JJJJ`; ungültige Eingaben kommen unverändert zurück. */
export function formatSwissDate(iso: string): string {
  const match = ISO_DATE.exec(iso)
  if (!match) return iso
  return `${match[3]}.${match[2]}.${match[1]}`
}
