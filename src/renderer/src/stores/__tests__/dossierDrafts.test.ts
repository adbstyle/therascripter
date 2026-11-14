import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createMockApi, emitApiEvent } from '../../test/mockApi'
import { flushPendingEdits } from '../../services/pendingEdits'
import {
  AUTOSAVE_DELAY_MS,
  discardDossierDraft,
  TECHNICAL_SAVE_ERROR,
  acquireDossierEditor,
  hasDossierDraft,
  releaseDossierEditor,
  resetDossierDrafts,
  type UpdateDossier
} from '../dossierDrafts'
import type { Dossier, UpdateDossierResult } from '../../../../shared/types/Dossier'

function makeDossier(over: Partial<Dossier> = {}): Dossier {
  return {
    id: 'd1',
    firstName: 'Lukas',
    lastName: 'Hofer',
    externalId: 'PD-1188',
    birthDate: '1978-02-03',
    diagnoses: '',
    medication: '',
    note: '',
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    ...over
  }
}

const ok = (over: Partial<Dossier> = {}): UpdateDossierResult => ({
  ok: true,
  dossier: makeDossier(over),
  duplicates: []
})

function deferred<T>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 10, 14, 10, 0))
  resetDossierDrafts()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('dossierDrafts — Autosave (#204 AK 10/11)', () => {
  it('speichert ein Feld nach der Tipp-Pause einzeln, ohne Speichern-Knopf', async () => {
    const update = vi.fn<UpdateDossier>().mockResolvedValue(ok({ note: 'Termine dienstags' }))
    const editor = acquireDossierEditor(makeDossier(), update)
    editor.change('note', 'Termine')
    editor.change('note', 'Termine dienstags')
    expect(editor.getState().status).toBe('saving')
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS - 1)
    expect(update).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    await settle()
    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith('d1', { note: 'Termine dienstags' })
    expect(editor.getState().status).toBe('saved')
  })

  it('speichert strikt nacheinander — höchstens eine Anfrage ist unterwegs', async () => {
    const first = deferred<UpdateDossierResult>()
    const update = vi.fn<UpdateDossier>().mockReturnValueOnce(first.promise).mockResolvedValue(ok())
    const editor = acquireDossierEditor(makeDossier(), update)
    editor.change('diagnoses', 'F32.1')
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS)
    editor.change('medication', 'Sertralin')
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS)
    await settle()
    expect(update).toHaveBeenCalledTimes(1)
    first.resolve(ok({ diagnoses: 'F32.1' }))
    await settle()
    expect(update).toHaveBeenCalledTimes(2)
    expect(update.mock.calls.map((c) => c[1])).toEqual([
      { diagnoses: 'F32.1' },
      { medication: 'Sertralin' }
    ])
  })

  it('sendet ungültige Felder nicht, meldet sie am Feld und speichert gültige trotzdem', async () => {
    const update = vi.fn<UpdateDossier>().mockResolvedValue(ok())
    const editor = acquireDossierEditor(makeDossier(), update)
    editor.change('lastName', '   ')
    editor.change('birthDate', '31.04.1980')
    editor.change('note', 'gültig')
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS)
    await settle()
    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith('d1', { note: 'gültig' })
    const state = editor.getState()
    expect(state.errors.lastName).toBe(
      'Der Nachname darf nicht leer sein. Diese Änderung ist noch nicht gespeichert.'
    )
    expect(state.errors.birthDate).toMatch(/TT\.MM\.JJJJ.*noch nicht gespeichert/)
    expect(state.values.lastName).toBe('   ')
    expect(state.status).toBe('error')

    // Korrigiert: Meldung verschwindet sofort, gespeichert wird nach der Pause
    editor.change('lastName', 'Hofer-Meier')
    expect(editor.getState().errors.lastName).toBeUndefined()
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS)
    await settle()
    expect(update).toHaveBeenLastCalledWith('d1', { lastName: 'Hofer-Meier' })
  })

  it('lehnt ein Geburtsdatum in der Zukunft ab und speichert ein gültiges als ISO (AK 8)', async () => {
    const update = vi.fn<UpdateDossier>().mockResolvedValue(ok())
    const editor = acquireDossierEditor(makeDossier(), update)
    editor.change('birthDate', '15.11.2026')
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS)
    await settle()
    expect(update).not.toHaveBeenCalled()
    editor.change('birthDate', '14.11.2026')
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS)
    await settle()
    expect(update).toHaveBeenCalledWith('d1', { birthDate: '2026-11-14' })
    editor.change('birthDate', '')
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS)
    await settle()
    expect(update).toHaveBeenLastCalledWith('d1', { birthDate: null })
  })

  it('lehnt ein Geburtsdatum vor 1900 als Tippfehler ab (Review #223)', async () => {
    const update = vi.fn<UpdateDossier>().mockResolvedValue(ok())
    const editor = acquireDossierEditor(makeDossier(), update)
    editor.change('birthDate', '03.02.0978')
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS)
    await settle()
    expect(update).not.toHaveBeenCalled()
    expect(editor.getState().errors.birthDate).toMatch(/^Bitte ein Datum ab 1900 eingeben\./)
  })

  it('zeigt eine vergebene Dossier-ID am Feld, behält die Eingabe und sendet sie nicht erneut (AK 5/11)', async () => {
    const update = vi
      .fn<UpdateDossier>()
      .mockResolvedValueOnce({ ok: false, reason: 'external-id-taken', ownerName: 'Meier, Anna' })
      .mockResolvedValue(ok())
    const editor = acquireDossierEditor(makeDossier(), update)
    editor.change('externalId', 'PD-0412')
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS)
    await settle()
    let state = editor.getState()
    expect(state.values.externalId).toBe('PD-0412')
    expect(state.errors.externalId).toBe(
      'Die Dossier-ID «PD-0412» trägt bereits das Patientendossier «Meier, Anna». Diese Änderung ist noch nicht gespeichert.'
    )
    expect(state.status).toBe('error')

    // Ein anderes Feld speichert trotzdem; die abgelehnte ID geht nicht nochmals raus
    editor.change('note', 'x')
    await editor.flush()
    expect(update).toHaveBeenCalledTimes(2)
    expect(update).toHaveBeenLastCalledWith('d1', { note: 'x' })
    state = editor.getState()
    expect(state.errors.externalId).toBeDefined()

    editor.change('externalId', 'PD-0413')
    await editor.flush()
    expect(update).toHaveBeenLastCalledWith('d1', { externalId: 'PD-0413' })
    expect(editor.getState().errors.externalId).toBeUndefined()
    expect(editor.getState().status).toBe('saved')
  })

  it('behält bei einem technischen Fehler die Eingabe und speichert über «Erneut versuchen» (AK 11)', async () => {
    const update = vi
      .fn<UpdateDossier>()
      .mockRejectedValueOnce(new Error('IPC kaputt'))
      .mockResolvedValue(ok())
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const editor = acquireDossierEditor(makeDossier(), update)
    editor.change('medication', 'Sertralin 50 mg')
    await editor.flush()
    expect(editor.getState().technicalError).toBe(TECHNICAL_SAVE_ERROR)
    expect(editor.getState().values.medication).toBe('Sertralin 50 mg')
    expect(editor.getState().status).toBe('error')

    editor.retry()
    await settle()
    expect(update).toHaveBeenCalledTimes(2)
    expect(update).toHaveBeenLastCalledWith('d1', { medication: 'Sertralin 50 mg' })
    expect(editor.getState().technicalError).toBeNull()
    expect(editor.getState().status).toBe('saved')
  })

  it('überschreibt nie die lokale Eingabe mit einer Antwort', async () => {
    const first = deferred<UpdateDossierResult>()
    const update = vi.fn<UpdateDossier>().mockReturnValueOnce(first.promise).mockResolvedValue(ok())
    const editor = acquireDossierEditor(makeDossier(), update)
    editor.change('firstName', 'Luk')
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS)
    await settle()
    editor.change('firstName', 'Lukas Andreas')
    first.resolve(ok({ firstName: 'Luk' }))
    await settle()
    expect(editor.getState().values.firstName).toBe('Lukas Andreas')
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS)
    await settle()
    expect(update).toHaveBeenLastCalledWith('d1', { firstName: 'Lukas Andreas' })
  })

  it('meldet gleiche Namen nach einer Namensänderung, speichert aber (AK 6)', async () => {
    const other = {
      id: 'd2',
      firstName: 'Anna',
      lastName: 'Meier',
      externalId: 'PD-0412',
      birthDate: null
    }
    const update = vi.fn<UpdateDossier>().mockResolvedValue({
      ok: true,
      dossier: makeDossier({ firstName: 'Anna', lastName: 'Meier' }),
      duplicates: [other]
    })
    const editor = acquireDossierEditor(makeDossier(), update)
    editor.change('firstName', 'Anna')
    await editor.flush()
    expect(editor.getState().duplicates).toEqual([other])
    expect(editor.getState().status).toBe('saved')
  })

  it('speichert beim Verlassen der Seite sofort und vergisst einen sauberen Editor', async () => {
    const update = vi.fn<UpdateDossier>().mockResolvedValue(ok())
    const editor = acquireDossierEditor(makeDossier(), update)
    editor.change('note', 'beim Verlassen')
    releaseDossierEditor(editor)
    await settle()
    expect(update).toHaveBeenCalledWith('d1', { note: 'beim Verlassen' })
    await settle()
    expect(hasDossierDraft('d1')).toBe(false)
  })

  it('behält einen Entwurf mit Meldung über das Verlassen der Seite hinaus', async () => {
    const update = vi.fn<UpdateDossier>().mockResolvedValue(ok())
    const editor = acquireDossierEditor(makeDossier(), update)
    editor.change('firstName', '')
    editor.change('note', 'gespeichert')
    releaseDossierEditor(editor)
    await settle()
    expect(hasDossierDraft('d1')).toBe(true)

    // Zurück: Eingabe und Meldung sind noch da, unveränderte Felder kommen frisch vom Main-Prozess
    const again = acquireDossierEditor(
      makeDossier({ note: 'gespeichert', diagnoses: 'F32.1' }),
      update
    )
    expect(again).toBe(editor)
    const state = again.getState()
    expect(state.values.firstName).toBe('')
    expect(state.errors.firstName).toMatch(/Vorname darf nicht leer sein/)
    expect(state.values.diagnoses).toBe('F32.1')
    expect(state.values.note).toBe('gespeichert')
  })

  it('zeigt eine abgelehnte ID nach Tippen und Löschen wieder als nicht gespeichert (Review #219)', async () => {
    const update = vi
      .fn<UpdateDossier>()
      .mockResolvedValue({ ok: false, reason: 'external-id-taken', ownerName: 'Meier, Anna' })
    const editor = acquireDossierEditor(makeDossier(), update)
    editor.change('externalId', 'PD-2')
    await editor.flush()
    expect(editor.getState().status).toBe('error')
    editor.change('externalId', 'PD-23')
    expect(editor.getState().errors.externalId).toBeUndefined()
    editor.change('externalId', 'PD-2')
    // Sofort wieder sichtbar, nicht erst nach der Pause
    expect(editor.getState().errors.externalId).toMatch(/«PD-2».*Meier, Anna/)
    await editor.flush()
    expect(update).toHaveBeenCalledTimes(1)
    expect(editor.getState().errors.externalId).toMatch(/noch nicht gespeichert/)
    expect(editor.getState().status).toBe('error')
  })
})

describe('dossierDrafts — Beenden der App und gelöschte Dossiers (Review #219)', () => {
  it('speichert beim Beenden alle gültigen ausstehenden Felder aller Dossiers', async () => {
    window.api = createMockApi()
    const update = vi.fn<UpdateDossier>().mockResolvedValue(ok())
    const a = acquireDossierEditor(makeDossier({ id: 'a' }), update)
    const b = acquireDossierEditor(makeDossier({ id: 'b' }), update)
    a.change('diagnoses', 'F32.1')
    a.change('medication', 'Sertralin')
    a.change('lastName', '')
    b.change('note', 'Notiz B')
    await flushPendingEdits()
    expect(update.mock.calls).toEqual([
      ['a', { diagnoses: 'F32.1' }],
      ['a', { medication: 'Sertralin' }],
      ['b', { note: 'Notiz B' }]
    ])
    expect(a.getState().errors.lastName).toBeDefined()
  })

  it('verwirft Entwürfe gelöschter Dossiers bei dossiers:changed', async () => {
    window.api = createMockApi()
    const update = vi.fn<UpdateDossier>().mockResolvedValue(ok())
    const editor = acquireDossierEditor(makeDossier(), update)
    editor.change('firstName', '')
    releaseDossierEditor(editor)
    await settle()
    expect(hasDossierDraft('d1')).toBe(true)
    emitApiEvent(window.api, 'dossiers.onChanged', { deletedIds: ['andere'] })
    expect(hasDossierDraft('d1')).toBe(true)
    emitApiEvent(window.api, 'dossiers.onChanged', { deletedIds: ['d1'] })
    expect(hasDossierDraft('d1')).toBe(false)
  })

  it('discardDossierDraft entfernt auch einen belegten Entwurf', () => {
    const editor = acquireDossierEditor(makeDossier(), vi.fn<UpdateDossier>())
    editor.change('note', 'x')
    discardDossierDraft('d1')
    expect(hasDossierDraft('d1')).toBe(false)
  })
})
