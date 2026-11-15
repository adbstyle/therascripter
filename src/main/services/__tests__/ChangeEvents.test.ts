import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const getAllWindows = vi.fn((): unknown[] => [])
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => getAllWindows() }
}))

import {
  notifyDossiersChanged,
  notifySessionsChanged,
  setChangeEventSenderForTests
} from '../ChangeEvents'
import {
  DossiersChangedSchema,
  MAX_CHANGED_IDS,
  SessionsChangedSchema
} from '../../../shared/validation/change-event-schemas'

function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

describe('ChangeEvents (Epic #192)', () => {
  const sent: { channel: string; deletedIds: string[] }[] = []

  beforeEach(() => {
    sent.length = 0
    setChangeEventSenderForTests((channel, data) => sent.push({ channel, ...data }))
  })

  afterEach(() => {
    setChangeEventSenderForTests(null)
  })

  it('bündelt alle Meldungen eines Ticks zu einem Event pro Kanal, IDs ohne Doppel', async () => {
    notifyDossiersChanged()
    notifyDossiersChanged(['d1'])
    notifyDossiersChanged(['d1', 'd2'])
    notifySessionsChanged(['s1'])
    notifySessionsChanged()
    notifySessionsChanged(['s1'])
    expect(sent).toEqual([])

    await nextTick()

    expect(sent).toEqual([
      { channel: 'dossiers:changed', deletedIds: ['d1', 'd2'] },
      { channel: 'sessions:changed', deletedIds: ['s1'] }
    ])
  })

  it('sendet bei reinen Änderungen eine leere Liste und beginnt danach neu', async () => {
    notifySessionsChanged()
    await nextTick()
    notifySessionsChanged(['s9'])
    await nextTick()
    expect(sent).toEqual([
      { channel: 'sessions:changed', deletedIds: [] },
      { channel: 'sessions:changed', deletedIds: ['s9'] }
    ])
  })

  it('teilt grosse Löschungen in Events, die das Schema annimmt', async () => {
    const ids = Array.from({ length: MAX_CHANGED_IDS + 500 }, (_, i) => `s${i}`)
    notifySessionsChanged(ids)
    notifyDossiersChanged(ids)
    await nextTick()
    expect(sent.map((e) => e.deletedIds.length)).toEqual([
      MAX_CHANGED_IDS,
      500,
      MAX_CHANGED_IDS,
      500
    ])
    for (const { channel, deletedIds } of sent) {
      const schema = channel === 'sessions:changed' ? SessionsChangedSchema : DossiersChangedSchema
      expect(schema.safeParse({ deletedIds }).success).toBe(true)
    }
    expect(sent.slice(0, 2).flatMap((e) => e.deletedIds)).toEqual(ids)
  })

  describe('Zustellung an die Fenster', () => {
    beforeEach(() => setChangeEventSenderForTests(null))

    it('sendet an jedes offene Fenster', async () => {
      const send = vi.fn()
      getAllWindows.mockReturnValue([{ isDestroyed: () => false, webContents: { send } }])
      notifyDossiersChanged(['d1'])
      await nextTick()
      expect(send).toHaveBeenCalledWith('dossiers:changed', { deletedIds: ['d1'] })
    })

    it('bleibt ohne Fenster still — kein Fehler, keine Warnung', async () => {
      const warn = vi.spyOn(console, 'warn')
      const error = vi.spyOn(console, 'error')
      getAllWindows.mockReturnValue([])
      notifySessionsChanged()
      await nextTick()
      getAllWindows.mockImplementation(() => {
        throw new Error('Electron fehlt')
      })
      notifySessionsChanged()
      await nextTick()
      expect(warn).not.toHaveBeenCalled()
      expect(error).not.toHaveBeenCalled()
      warn.mockRestore()
      error.mockRestore()
    })
  })
})
