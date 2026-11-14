import {
  formatSwissDate,
  BEFORE_MIN_YEAR_MESSAGE,
  isBeforeMinYear,
  isValidIsoDateNotAfter,
  localTodayIso,
  parseSwissDate
} from '../../../shared/utils/calendar-date'
import {
  hasControlChars,
  hasControlCharsExceptLineBreaks,
  isBlankDossierText
} from '../../../shared/utils/dossier-normalize'
import {
  MAX_DOSSIER_EXTERNAL_ID_LENGTH,
  MAX_DOSSIER_FREE_TEXT_LENGTH,
  MAX_DOSSIER_NAME_LENGTH
} from '../../../shared/validation/dossier-schemas'
import { registerPendingEditsFlusher } from '../services/pendingEdits'
import type {
  Dossier,
  DossierPatch,
  DossierRef,
  UpdateDossierResult
} from '../../../shared/types/Dossier'

/**
 * Stammdaten-Entwürfe und Autosave der Patientendossiers (#204 AK 10/11).
 *
 * Pro geöffnetem Dossier gibt es EINEN Editor im Speicher des Renderers (nie
 * auf der Platte). Er ist die Wahrheit für das Formular:
 * - Eingaben landen sofort im lokalen Zustand; Antworten des Main-Prozesses
 *   überschreiben ihn nie.
 * - Jedes Feld wird nach `AUTOSAVE_DELAY_MS` ohne weitere Eingabe einzeln
 *   gespeichert (Patch mit genau diesem Feld), alle Felder strikt
 *   nacheinander — höchstens eine Anfrage ist unterwegs.
 * - Ungültige Felder werden nicht gesendet und tragen eine Meldung; gültige
 *   Felder speichern trotzdem.
 * - Abgelehnte (Dossier-ID vergeben) oder gescheiterte Änderungen bleiben als
 *   Eingabe stehen.
 * - Der Editor überlebt das Verlassen der Seite, solange etwas nicht
 *   gespeichert ist: wer zurückkommt, findet Eingabe und Meldung wieder.
 */

export type DossierField =
  | 'firstName'
  | 'lastName'
  | 'externalId'
  | 'birthDate'
  | 'diagnoses'
  | 'medication'
  | 'note'

export const DOSSIER_FIELDS: readonly DossierField[] = [
  'firstName',
  'lastName',
  'externalId',
  'birthDate',
  'diagnoses',
  'medication',
  'note'
]

/** Formularwerte als Text; das Geburtsdatum als `TT.MM.JJJJ`. */
export type DossierFieldValues = Record<DossierField, string>

export type DossierSaveStatus = 'saved' | 'saving' | 'error'

export interface DossierEditorState {
  values: DossierFieldValues
  /** Meldung am Feld: ungültige Eingabe oder vom Main-Prozess abgelehnt. */
  errors: Partial<Record<DossierField, string>>
  /** Technischer Fehler beim Speichern (Eingaben bleiben erhalten). */
  technicalError: string | null
  /** Andere Dossiers mit demselben Namen, gemeldet nach einer Namensänderung (#204 AK 6). */
  duplicates: DossierRef[]
  status: DossierSaveStatus
}

export interface DossierEditor {
  readonly dossierId: string
  getState: () => DossierEditorState
  subscribe: (listener: () => void) => () => void
  change: (field: DossierField, value: string) => void
  /** Feld verlassen: ausstehende Änderung dieses Felds sofort speichern. */
  commit: (field: DossierField) => void
  /** Alle ausstehenden Änderungen sofort speichern; erfüllt sich, sobald nichts mehr läuft. */
  flush: () => Promise<void>
  /** Nach einem technischen Fehler die gescheiterten Felder erneut senden. */
  retry: () => void
}

export type UpdateDossier = (dossierId: string, patch: DossierPatch) => Promise<UpdateDossierResult>

export const AUTOSAVE_DELAY_MS = 500

const NOT_SAVED = 'Diese Änderung ist noch nicht gespeichert.'

export const TECHNICAL_SAVE_ERROR =
  'Eine Änderung konnte nicht gespeichert werden. Ihre Eingaben bleiben erhalten.'
export const DOSSIER_GONE_ERROR =
  'Dieses Patientendossier gibt es nicht mehr. Ihre Änderungen konnten nicht gespeichert werden.'

const FIELD_LABELS: Record<DossierField, string> = {
  firstName: 'Der Vorname',
  lastName: 'Der Nachname',
  externalId: 'Die Dossier-ID',
  birthDate: 'Das Geburtsdatum',
  diagnoses: 'Die Diagnosen',
  medication: 'Die Medikation',
  note: 'Die Notiz'
}

const MAX_LENGTH: Record<DossierField, number> = {
  firstName: MAX_DOSSIER_NAME_LENGTH,
  lastName: MAX_DOSSIER_NAME_LENGTH,
  externalId: MAX_DOSSIER_EXTERNAL_ID_LENGTH,
  birthDate: 10,
  diagnoses: MAX_DOSSIER_FREE_TEXT_LENGTH,
  medication: MAX_DOSSIER_FREE_TEXT_LENGTH,
  note: MAX_DOSSIER_FREE_TEXT_LENGTH
}

export function dossierMaxLength(field: DossierField): number {
  return MAX_LENGTH[field]
}

export const BIRTH_DATE_ERROR =
  'Geburtsdatum bitte als vollständiges Datum TT.MM.JJJJ angeben, nicht in der Zukunft.'

export function externalIdTakenMessage(externalId: string, ownerName: string): string {
  return ownerName
    ? `Die Dossier-ID «${externalId.trim()}» trägt bereits das Patientendossier «${ownerName}».`
    : `Die Dossier-ID «${externalId.trim()}» trägt bereits ein anderes Patientendossier.`
}

type Validation = { ok: true; patch: DossierPatch } | { ok: false; message: string }

/**
 * Prüft einen Feldwert wie der Main-Prozess (gleiche Hilfsfunktionen) und
 * liefert den Patch, der gesendet wird. Meldung ohne «noch nicht gespeichert».
 */
export function validateDossierField(field: DossierField, value: string): Validation {
  const label = FIELD_LABELS[field]
  if (value.length > MAX_LENGTH[field]) {
    return { ok: false, message: `${label} ist zu lang (höchstens ${MAX_LENGTH[field]} Zeichen).` }
  }
  switch (field) {
    case 'firstName':
    case 'lastName':
      if (isBlankDossierText(value)) return { ok: false, message: `${label} darf nicht leer sein.` }
      if (hasControlChars(value)) {
        return { ok: false, message: `${label} enthält unzulässige Zeichen.` }
      }
      return { ok: true, patch: { [field]: value } }
    case 'externalId':
      if (hasControlChars(value)) {
        return { ok: false, message: `${label} enthält unzulässige Zeichen.` }
      }
      return { ok: true, patch: { externalId: isBlankDossierText(value) ? null : value } }
    case 'birthDate': {
      if (value.trim() === '') return { ok: true, patch: { birthDate: null } }
      const iso = parseSwissDate(value)
      if (iso && isBeforeMinYear(iso)) return { ok: false, message: BEFORE_MIN_YEAR_MESSAGE }
      if (!iso || !isValidIsoDateNotAfter(iso, localTodayIso())) {
        return { ok: false, message: BIRTH_DATE_ERROR }
      }
      return { ok: true, patch: { birthDate: iso } }
    }
    case 'diagnoses':
    case 'medication':
    case 'note':
      if (hasControlCharsExceptLineBreaks(value)) {
        return { ok: false, message: `${label} enthält unzulässige Zeichen.` }
      }
      return { ok: true, patch: { [field]: value } }
  }
}

export function dossierToValues(dossier: Dossier): DossierFieldValues {
  return {
    firstName: dossier.firstName,
    lastName: dossier.lastName,
    externalId: dossier.externalId ?? '',
    birthDate: dossier.birthDate ? formatSwissDate(dossier.birthDate) : '',
    diagnoses: dossier.diagnoses,
    medication: dossier.medication,
    note: dossier.note
  }
}

interface EditorInternals extends DossierEditor {
  /** Werte eines frisch geladenen Dossiers für alle unveränderten Felder übernehmen. */
  adopt: (dossier: Dossier) => void
  isIdle: () => boolean
  isClean: () => boolean
  dispose: () => void
  refCount: number
  onIdle: (() => void) | null
}

function createEditor(dossier: Dossier, update: UpdateDossier): EditorInternals {
  const dossierId = dossier.id
  const values: DossierFieldValues = dossierToValues(dossier)
  /** Zuletzt erfolgreich gespeicherter Formularwert pro Feld. */
  const saved: DossierFieldValues = { ...values }
  const errors: Partial<Record<DossierField, string>> = {}
  /** Wert, den der Main-Prozess abgelehnt hat — nicht erneut senden, bis er sich ändert. */
  const rejected: Partial<Record<DossierField, { value: string; message: string }>> = {}
  const failed = new Set<DossierField>()
  const timers = new Map<DossierField, ReturnType<typeof setTimeout>>()
  const queue: DossierField[] = []
  let running = false
  let technicalError: string | null = null
  let duplicates: DossierRef[] = []
  let disposed = false
  const listeners = new Set<() => void>()
  let idleWaiters: Array<() => void> = []
  let snapshot: DossierEditorState

  function computeStatus(): DossierSaveStatus {
    const hasFieldError = DOSSIER_FIELDS.some((f) => errors[f] && values[f] !== saved[f])
    if (technicalError || hasFieldError) return 'error'
    if (timers.size > 0 || queue.length > 0 || running) return 'saving'
    return 'saved'
  }

  function emit(): void {
    snapshot = {
      values: { ...values },
      errors: { ...errors },
      technicalError,
      duplicates,
      status: computeStatus()
    }
    for (const listener of [...listeners]) listener()
  }

  function isIdle(): boolean {
    return timers.size === 0 && queue.length === 0 && !running
  }

  function isClean(): boolean {
    return (
      technicalError === null &&
      failed.size === 0 &&
      DOSSIER_FIELDS.every((f) => values[f] === saved[f] && !errors[f])
    )
  }

  function enqueue(field: DossierField): void {
    if (!queue.includes(field)) queue.push(field)
    void processQueue()
  }

  async function saveField(field: DossierField): Promise<void> {
    const value = values[field]
    if (value === saved[field]) {
      delete errors[field]
      delete rejected[field]
      return
    }
    const check = validateDossierField(field, value)
    if (!check.ok) {
      errors[field] = `${check.message} ${NOT_SAVED}`
      return
    }
    // Derselbe abgelehnte Wert (z. B. nach Tippen und Löschen eines Zeichens):
    // nicht erneut senden, aber die Ablehnung wieder anzeigen
    const known = rejected[field]
    if (known && known.value === value) {
      errors[field] = known.message
      return
    }

    let result: UpdateDossierResult
    try {
      result = await update(dossierId, check.patch)
    } catch (error) {
      console.error('[dossierDrafts] Speichern fehlgeschlagen:', error)
      failed.add(field)
      technicalError = TECHNICAL_SAVE_ERROR
      return
    }

    if (result.ok) {
      saved[field] = value
      failed.delete(field)
      delete rejected[field]
      if (failed.size === 0 && technicalError === TECHNICAL_SAVE_ERROR) technicalError = null
      if (values[field] === value) delete errors[field]
      if (field === 'firstName' || field === 'lastName') duplicates = result.duplicates
    } else if (result.reason === 'external-id-taken') {
      const message = `${externalIdTakenMessage(value, result.ownerName)} ${NOT_SAVED}`
      rejected[field] = { value, message }
      if (values[field] === value) errors[field] = message
    } else {
      failed.add(field)
      technicalError = DOSSIER_GONE_ERROR
    }
  }

  async function processQueue(): Promise<void> {
    if (running) return
    running = true
    emit()
    try {
      while (queue.length > 0 && !disposed) {
        const field = queue.shift() as DossierField
        await saveField(field)
        emit()
      }
    } finally {
      running = false
      emit()
      if (isIdle()) {
        const waiters = idleWaiters
        idleWaiters = []
        for (const resolve of waiters) resolve()
        editor.onIdle?.()
      }
    }
  }

  function clearTimer(field: DossierField): boolean {
    const timer = timers.get(field)
    if (timer === undefined) return false
    clearTimeout(timer)
    timers.delete(field)
    return true
  }

  const editor: EditorInternals = {
    dossierId,
    refCount: 0,
    onIdle: null,
    getState: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    change: (field, value) => {
      if (disposed) return
      values[field] = value
      // Eine Meldung verschwindet, sobald die Eingabe wieder stimmt; eine
      // neue erscheint erst nach der Tipp-Pause (beim Speicherversuch).
      const known = rejected[field]
      if (known && known.value === value) {
        errors[field] = known.message
      } else if (errors[field] && validateDossierField(field, value).ok) {
        delete errors[field]
      }
      clearTimer(field)
      timers.set(
        field,
        setTimeout(() => {
          timers.delete(field)
          enqueue(field)
        }, AUTOSAVE_DELAY_MS)
      )
      emit()
    },
    commit: (field) => {
      if (clearTimer(field)) enqueue(field)
    },
    flush: () => {
      for (const field of [...timers.keys()]) {
        clearTimer(field)
        if (!queue.includes(field)) queue.push(field)
      }
      if (isIdle()) return Promise.resolve()
      const done = new Promise<void>((resolve) => idleWaiters.push(resolve))
      void processQueue()
      return done
    },
    retry: () => {
      if (technicalError === DOSSIER_GONE_ERROR) return
      technicalError = null
      const fields = [...failed]
      failed.clear()
      for (const field of fields) enqueue(field)
      emit()
    },
    adopt: (fresh) => {
      const freshValues = dossierToValues(fresh)
      for (const field of DOSSIER_FIELDS) {
        if (values[field] === saved[field] && !timers.has(field) && !errors[field]) {
          values[field] = freshValues[field]
          saved[field] = freshValues[field]
        }
      }
      emit()
    },
    isIdle,
    isClean,
    dispose: () => {
      disposed = true
      for (const field of [...timers.keys()]) clearTimer(field)
      queue.length = 0
      listeners.clear()
    }
  }
  emit()
  return editor
}

const editors = new Map<string, EditorInternals>()

let integrated = false

/**
 * Einmalig beim ersten Editor: beim Beenden der App alle Entwürfe speichern
 * und Entwürfe gelöschter Dossiers verwerfen — Klarnamen und Diagnosen
 * sollen nicht im Speicher des Renderers zurückbleiben.
 */
function ensureIntegration(): void {
  if (integrated) return
  integrated = true
  registerPendingEditsFlusher(flushAllDossierDrafts)
  const api = typeof window !== 'undefined' ? window.api?.dossiers : undefined
  api?.onChanged(({ deletedIds }) => {
    for (const id of deletedIds) discardDossierDraft(id)
  })
}

function removeIfUnused(editor: EditorInternals): void {
  if (editor.refCount === 0 && editor.isIdle() && editor.isClean()) {
    editor.dispose()
    if (editors.get(editor.dossierId) === editor) editors.delete(editor.dossierId)
  }
}

/**
 * Editor eines Dossiers holen (und belegen). Gibt es schon einen — etwa weil
 * beim letzten Besuch etwas nicht gespeichert wurde —, bleibt dessen Eingabe
 * die Wahrheit; nur unveränderte Felder übernehmen den frisch geladenen Stand.
 */
export function acquireDossierEditor(
  dossier: Dossier,
  update: UpdateDossier = (id, patch) => window.api.dossiers.update(id, patch)
): DossierEditor {
  ensureIntegration()
  let editor = editors.get(dossier.id)
  if (editor) {
    editor.adopt(dossier)
  } else {
    editor = createEditor(dossier, update)
    editors.set(dossier.id, editor)
  }
  editor.refCount++
  const current = editor
  current.onIdle = () => removeIfUnused(current)
  return editor
}

/**
 * Seite verlassen: ausstehende Änderungen sofort senden. Ist danach alles
 * gespeichert, verschwindet der Editor; sonst bleibt er als Entwurf.
 */
export function releaseDossierEditor(editor: DossierEditor): void {
  const internal = editors.get(editor.dossierId)
  if (!internal || internal !== editor) return
  internal.refCount = Math.max(0, internal.refCount - 1)
  if (internal.refCount === 0) void internal.flush().then(() => removeIfUnused(internal))
}

/** Entwurf verwerfen, z. B. nachdem das Dossier gelöscht wurde. */
export function discardDossierDraft(dossierId: string): void {
  const editor = editors.get(dossierId)
  if (!editor) return
  editor.dispose()
  editors.delete(dossierId)
}

/**
 * Alle gültigen ausstehenden Felder aller Dossiers sofort speichern, Dossier
 * für Dossier und je Dossier Feld für Feld — beim Beenden der App.
 */
export async function flushAllDossierDrafts(): Promise<void> {
  for (const editor of [...editors.values()]) await editor.flush()
}

export function hasDossierDraft(dossierId: string): boolean {
  return editors.has(dossierId)
}

/** Nur für Tests. */
export function resetDossierDrafts(): void {
  for (const editor of editors.values()) editor.dispose()
  editors.clear()
  integrated = false
}
