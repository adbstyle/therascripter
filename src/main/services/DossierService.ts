import type Database from 'better-sqlite3'
import { createHash, randomUUID } from 'crypto'
import {
  DossierRepository,
  type DossierRecordPatch,
  type DossierSessionScopeRow
} from '../db/repositories/DossierRepository'
import { walCheckpointTruncate } from '../db/maintenance'
import { SearchRecentRepository } from '../db/repositories/SearchRecentRepository'
import { SessionService } from './SessionService'
import { notifyDossiersChanged, notifySessionsChanged } from './ChangeEvents'
import {
  cleanDossierText,
  hasControlChars,
  hasControlCharsExceptLineBreaks,
  isBlankDossierText,
  normalizeDossierKey
} from '../../shared/utils/dossier-normalize'
import { isValidIsoDateNotAfter, localTodayIso } from '../../shared/utils/calendar-date'
import type {
  CreateDossierInput,
  CreateDossierResult,
  DeleteDossierResult,
  Dossier,
  DossierDeletePreview,
  DossierListItem,
  DossierPatch,
  DossierRef,
  UpdateDossierResult
} from '../../shared/types/Dossier'

export interface DossierServiceDeps {
  /** Sitzung, die gerade aufgenommen wird (recording-handlers), sonst null. */
  getActiveSessionId?: () => string | null
}

interface DeleteScope {
  preview: DossierDeletePreview
  exclusiveIds: string[]
}

/** «Nachname, Vorname» — wie in der Übersicht. */
function listName(ref: Pick<DossierRef, 'firstName' | 'lastName'>): string {
  return `${ref.lastName}, ${ref.firstName}`
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  )
}

function cleanName(value: string): string {
  if (hasControlChars(value)) throw new Error('Name enthält Steuerzeichen')
  if (isBlankDossierText(value)) throw new Error('Vor- und Nachname dürfen nicht leer sein')
  return cleanDossierText(value)
}

/**
 * Leere bzw. nur aus Leerraum oder unsichtbaren Zeichen bestehende
 * Dossier-ID wird als «keine ID» (NULL) gespeichert.
 */
function cleanExternalId(value: string | null | undefined): string | null {
  if (value == null) return null
  if (hasControlChars(value)) throw new Error('Dossier-ID enthält Steuerzeichen')
  return isBlankDossierText(value) ? null : cleanDossierText(value)
}

function checkFreeText(value: string): string {
  if (hasControlCharsExceptLineBreaks(value)) throw new Error('Text enthält Steuerzeichen')
  return value
}

function checkBirthDate(value: string | null | undefined): string | null {
  if (value == null) return null
  if (!isValidIsoDateNotAfter(value, localTodayIso())) {
    throw new Error('Ungültiges Geburtsdatum')
  }
  return value
}

function fingerprintOf(exclusiveIds: string[], sharedIds: string[]): string {
  const key = `${[...exclusiveIds].sort().join(',')}|${[...sharedIds].sort().join(',')}`
  return createHash('sha256').update(key).digest('hex')
}

function countByType(rows: DossierSessionScopeRow[]): { sessions: number; pdfs: number } {
  let sessions = 0
  let pdfs = 0
  for (const row of rows) {
    if (row.type === 'pdf') pdfs++
    else sessions++
  }
  return { sessions, pdfs }
}

/**
 * Patientendossiers (#204). Alle Ergebnisse sind typisierte Unions statt
 * Exceptions — Electron verstümmelt Fehlermeldungen bei `invoke`. Exceptions
 * gibt es nur für Programmierfehler (ungültige Eingaben, die das Zod-Schema
 * schon abfangen müsste).
 */
export class DossierService {
  private repository: DossierRepository
  private sessions: SessionService
  private getActiveSessionId: () => string | null

  constructor(
    private db: Database.Database,
    deps: DossierServiceDeps = {}
  ) {
    this.repository = new DossierRepository(db)
    this.sessions = new SessionService(db)
    this.getActiveSessionId = deps.getActiveSessionId ?? ((): null => null)
  }

  list(): DossierListItem[] {
    return this.repository.listSummaries()
  }

  get(id: string): Dossier | null {
    return this.repository.findById(id)
  }

  create(input: CreateDossierInput): CreateDossierResult {
    const firstName = cleanName(input.firstName)
    const lastName = cleanName(input.lastName)
    const firstNameNorm = normalizeDossierKey(firstName)
    const lastNameNorm = normalizeDossierKey(lastName)
    const externalId = cleanExternalId(input.externalId)
    const externalIdNorm = externalId === null ? null : normalizeDossierKey(externalId)
    const birthDate = checkBirthDate(input.birthDate)

    if (externalIdNorm !== null) {
      const owner = this.repository.findByExternalIdNorm(externalIdNorm)
      if (owner) return { ok: false, reason: 'external-id-taken', ownerName: listName(owner) }
    }

    const duplicates = this.repository.findSameName(firstNameNorm, lastNameNorm)
    if (duplicates.length > 0 && input.confirmDuplicate !== true) {
      return { ok: false, reason: 'duplicate-name', duplicates }
    }

    const now = new Date().toISOString()
    let dossier: Dossier
    try {
      dossier = this.repository.create({
        id: randomUUID(),
        firstName,
        lastName,
        firstNameNorm,
        lastNameNorm,
        externalId,
        externalIdNorm,
        birthDate,
        diagnoses: '',
        medication: '',
        note: '',
        createdAt: now,
        updatedAt: now
      })
    } catch (error) {
      // Zwei gleichzeitige Anfragen mit derselben ID: der Unique-Index entscheidet.
      if (externalIdNorm !== null && isUniqueViolation(error)) {
        return this.externalIdTaken(externalIdNorm)
      }
      throw error
    }

    notifyDossiersChanged()
    return { ok: true, dossier }
  }

  /**
   * Autosave pro Feld (#204 AK 10). Eine belegte Dossier-ID lehnt die ganze
   * Änderung ab (AK 5); gleicher Name wird gespeichert und nur gemeldet (AK 6).
   */
  update(id: string, patch: DossierPatch): UpdateDossierResult {
    const record: DossierRecordPatch = {}
    if (patch.firstName !== undefined) {
      record.firstName = cleanName(patch.firstName)
      record.firstNameNorm = normalizeDossierKey(record.firstName)
    }
    if (patch.lastName !== undefined) {
      record.lastName = cleanName(patch.lastName)
      record.lastNameNorm = normalizeDossierKey(record.lastName)
    }
    if (patch.externalId !== undefined) {
      record.externalId = cleanExternalId(patch.externalId)
      record.externalIdNorm =
        record.externalId === null ? null : normalizeDossierKey(record.externalId)
    }
    if (patch.birthDate !== undefined) record.birthDate = checkBirthDate(patch.birthDate)
    if (patch.diagnoses !== undefined) record.diagnoses = checkFreeText(patch.diagnoses)
    if (patch.medication !== undefined) record.medication = checkFreeText(patch.medication)
    if (patch.note !== undefined) record.note = checkFreeText(patch.note)

    if (!this.repository.findById(id)) return { ok: false, reason: 'not-found' }

    if (record.externalIdNorm != null) {
      const owner = this.repository.findByExternalIdNorm(record.externalIdNorm, id)
      if (owner) return { ok: false, reason: 'external-id-taken', ownerName: listName(owner) }
    }

    let dossier: Dossier | null
    try {
      dossier = this.repository.update(id, record, new Date().toISOString())
    } catch (error) {
      if (record.externalIdNorm != null && isUniqueViolation(error)) {
        return this.externalIdTaken(record.externalIdNorm)
      }
      throw error
    }
    if (!dossier) return { ok: false, reason: 'not-found' }

    const duplicates = this.repository.findSameName(
      normalizeDossierKey(dossier.firstName),
      normalizeDossierKey(dossier.lastName),
      id
    )

    // Freitexte erscheinen nirgends sonst — kein Event, kein Refetch-Sturm beim Tippen.
    if (
      patch.firstName !== undefined ||
      patch.lastName !== undefined ||
      patch.externalId !== undefined ||
      patch.birthDate !== undefined
    ) {
      notifyDossiersChanged()
    }
    return { ok: true, dossier, duplicates }
  }

  /** Was das Löschen mitnimmt (#204 AK 17, #207); null, wenn es das Dossier nicht gibt. */
  deletePreview(id: string): DossierDeletePreview | null {
    return this.computeDeleteScope(id)?.preview ?? null
  }

  /**
   * Löscht ein Patientendossier samt exklusiv zugeordneter Sitzungen (#204, #207).
   *
   * Phase 1 (eine Transaktion): Vorschau neu berechnen; stimmt der Fingerprint
   * nicht mehr, wird nichts gelöscht (`changed`). Eine exklusive laufende
   * Aufnahme sperrt das Löschen. Sonst werden die exklusiven Sitzungen als
   * «wird gelöscht» markiert (Löschweg #202) und das Dossier gelöscht —
   * Zuordnungen und «Zuletzt»-Einträge per Cascade. Nach dem Commit ist das
   * Dossier atomar weg, die Sitzungen für alle Lesewege unsichtbar.
   *
   * Phase 2: jede markierte Sitzung über SessionService.finishDeletion
   * abschliessen (Tasks abbrechen, Dateien und Zeile löschen). Bleibt etwas
   * übrig, ist `incomplete` true und der Start-Pfad aus #202
   * (finishPendingDeletions) schliesst es beim nächsten Start ab (#204 PC 5).
   * Danach WAL-Checkpoint, damit mit secure_delete keine Kopie in .db oder
   * -wal bleibt (#204 PC 4); den Fall «Absturz vor dem Checkpoint» deckt der
   * Checkpoint beim Start (runStartupMaintenance).
   *
   * IPC-Handler laufen synchron im Main-Prozess: zwischen Prüfung und Löschen
   * kann keine Aufnahme starten.
   */
  deleteDossier(id: string, fingerprint: string): DeleteDossierResult {
    const phase1 = this.db.transaction(
      ():
        | { kind: 'done'; exclusiveIds: string[] }
        | { kind: 'result'; result: DeleteDossierResult } => {
        const scope = this.computeDeleteScope(id)
        if (!scope) return { kind: 'result', result: { ok: false, reason: 'not-found' } }
        if (scope.preview.fingerprint !== fingerprint) {
          return {
            kind: 'result',
            result: { ok: false, reason: 'changed', preview: scope.preview }
          }
        }
        if (scope.preview.blockedByRecording) {
          return { kind: 'result', result: { ok: false, reason: 'blocked-recording' } }
        }
        this.sessions.markForDeletion(scope.exclusiveIds)
        // #209 PC 4 — letzte Suchanfragen mit Vor-/Nachname oder ID dieses
        // Dossiers gehen mit; der Checkpoint unten entfernt sie aus den Dateien
        const ref = this.repository.findRefById(id)
        if (ref) {
          new SearchRecentRepository(this.db).forgetContaining([
            ref.firstName,
            ref.lastName,
            ref.externalId
          ])
        }
        this.repository.delete(id)
        return { kind: 'done', exclusiveIds: scope.exclusiveIds }
      }
    )()

    if (phase1.kind === 'result') return phase1.result

    let incomplete = false
    for (const sessionId of phase1.exclusiveIds) {
      try {
        if (!this.sessions.finishDeletion(sessionId)) incomplete = true
      } catch (error) {
        incomplete = true
        console.error(
          `[DossierService] Sitzung ${sessionId} konnte nicht vollständig gelöscht werden — wird beim nächsten Start abgeschlossen:`,
          error
        )
      }
    }

    try {
      if (!walCheckpointTruncate(this.db)) {
        console.error(
          '[DossierService] WAL-Checkpoint nach dem Löschen blockiert — wird beim nächsten Löschen bzw. Start nachgeholt'
        )
      }
    } catch (error) {
      console.error('[DossierService] WAL-Checkpoint nach dem Löschen fehlgeschlagen:', error)
    }

    // Auch geteilte Sitzungen ändern sich (eine Zuordnung weniger).
    notifySessionsChanged(phase1.exclusiveIds)
    notifyDossiersChanged([id])
    return { ok: true, deletedSessionIds: phase1.exclusiveIds, incomplete }
  }

  private computeDeleteScope(id: string): DeleteScope | null {
    const ref = this.repository.findRefById(id)
    if (!ref) return null

    const scope = this.repository.findSessionScope(id)
    const exclusive = scope.filter((row) => row.otherCount === 0)
    const shared = scope.filter((row) => row.otherCount > 0)
    const exclusiveIds = exclusive.map((row) => row.id)
    const activeSessionId = this.getActiveSessionId()

    return {
      exclusiveIds,
      preview: {
        dossierId: ref.id,
        displayName: `${ref.firstName} ${ref.lastName}`,
        exclusive: countByType(exclusive),
        shared: {
          ...countByType(shared),
          otherDossiers: shared.length > 0 ? this.repository.findDossiersSharingSessions(id) : []
        },
        blockedByRecording: activeSessionId !== null && exclusiveIds.includes(activeSessionId),
        fingerprint: fingerprintOf(
          exclusiveIds,
          shared.map((row) => row.id)
        )
      }
    }
  }

  private externalIdTaken(externalIdNorm: string): {
    ok: false
    reason: 'external-id-taken'
    ownerName: string
  } {
    const owner = this.repository.findByExternalIdNorm(externalIdNorm)
    return {
      ok: false,
      reason: 'external-id-taken',
      ownerName: owner ? listName(owner) : ''
    }
  }
}
