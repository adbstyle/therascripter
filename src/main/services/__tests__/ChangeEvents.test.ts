import { describe, it, expect, vi, beforeEach } from 'vitest'

const sendToRenderer = vi.fn()
vi.mock('../../utils/ipc-helpers', () => ({
  sendToRenderer: (...args: unknown[]) => sendToRenderer(...args)
}))

import { notifySessionsChanged } from '../ChangeEvents'
import {
  MAX_CHANGED_IDS,
  SessionsChangedSchema
} from '../../../shared/validation/change-event-schemas'

const nextTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

beforeEach(() => {
  sendToRenderer.mockReset()
})

describe('ChangeEvents (Epic #192)', () => {
  it('bündelt alle Meldungen eines Ticks zu einem Event', async () => {
    notifySessionsChanged()
    notifySessionsChanged()
    notifySessionsChanged()
    expect(sendToRenderer).not.toHaveBeenCalled()

    await nextTick()
    expect(sendToRenderer).toHaveBeenCalledTimes(1)
    expect(sendToRenderer).toHaveBeenCalledWith('sessions:changed', { deletedIds: [] })
  })

  it('sammelt gelöschte IDs ohne Doppel', async () => {
    notifySessionsChanged(['a'])
    notifySessionsChanged()
    notifySessionsChanged(['b', 'a'])
    await nextTick()
    expect(sendToRenderer).toHaveBeenCalledTimes(1)
    expect(sendToRenderer.mock.calls[0][1]).toEqual({ deletedIds: ['a', 'b'] })
  })

  it('beginnt nach dem Senden einen neuen Bündel', async () => {
    notifySessionsChanged(['a'])
    await nextTick()
    notifySessionsChanged()
    await nextTick()
    expect(sendToRenderer).toHaveBeenCalledTimes(2)
    expect(sendToRenderer.mock.calls[1][1]).toEqual({ deletedIds: [] })
  })

  it('teilt grosse Löschungen in Events, die das Schema annimmt', async () => {
    const ids = Array.from({ length: MAX_CHANGED_IDS + 5 }, (_, i) => `s${i}`)
    notifySessionsChanged(ids)
    await nextTick()
    expect(sendToRenderer).toHaveBeenCalledTimes(2)
    for (const [, payload] of sendToRenderer.mock.calls) {
      expect(SessionsChangedSchema.safeParse(payload).success).toBe(true)
    }
    const sent = sendToRenderer.mock.calls.flatMap(
      ([, p]) => (p as { deletedIds: string[] }).deletedIds
    )
    expect(sent).toEqual(ids)
  })

  it('bleibt ohne Fenster still (kein Absturz)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    sendToRenderer.mockImplementation(() => {
      throw new Error('kein Fenster')
    })
    notifySessionsChanged()
    await nextTick()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
