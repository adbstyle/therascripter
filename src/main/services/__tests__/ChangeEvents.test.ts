import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] }
}))

import {
  notifyDossiersChanged,
  notifySessionsChanged,
  setChangeEventSenderForTests
} from '../ChangeEvents'

function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

describe('ChangeEvents', () => {
  const sent: { channel: string; deletedIds: string[] }[] = []

  beforeEach(() => {
    sent.length = 0
    setChangeEventSenderForTests((channel, data) => sent.push({ channel, ...data }))
  })

  afterEach(() => {
    setChangeEventSenderForTests(null)
  })

  it('bundles all notifications of one tick into one event per channel', async () => {
    notifyDossiersChanged()
    notifyDossiersChanged(['d1'])
    notifyDossiersChanged(['d1', 'd2'])
    notifySessionsChanged(['s1'])
    notifySessionsChanged()
    expect(sent).toEqual([])

    await nextTick()

    expect(sent).toEqual([
      { channel: 'dossiers:changed', deletedIds: ['d1', 'd2'] },
      { channel: 'sessions:changed', deletedIds: ['s1'] }
    ])
  })

  it('sends an empty id list for plain changes and starts fresh in the next tick', async () => {
    notifyDossiersChanged()
    await nextTick()
    notifyDossiersChanged(['d9'])
    await nextTick()
    expect(sent).toEqual([
      { channel: 'dossiers:changed', deletedIds: [] },
      { channel: 'dossiers:changed', deletedIds: ['d9'] }
    ])
  })

  it('splits more than 1000 deleted ids into several events (schema limit)', async () => {
    notifySessionsChanged(Array.from({ length: 1500 }, (_, i) => `s${i}`))
    await nextTick()
    expect(sent.map((e) => e.deletedIds.length)).toEqual([1000, 500])
  })
})
