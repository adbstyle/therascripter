import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import {
  FLUSH_PENDING_EDITS_TIMEOUT_MS,
  requestRendererFlush,
  runQuitCleanup,
  type FlushTarget
} from '../PendingEditsFlush'
import {
  FLUSH_PENDING_EDITS_CHANNEL,
  PENDING_EDITS_FLUSHED_CHANNEL
} from '../../../shared/types/ipc/PendingEditsApi'

function target(replies: EventEmitter, opts: { answer?: boolean; destroyed?: boolean } = {}) {
  const sent: Array<[string, string]> = []
  const t: FlushTarget = {
    isDestroyed: () => opts.destroyed === true,
    send: (channel, id) => {
      sent.push([channel, id])
      if (opts.answer !== false)
        setTimeout(() => replies.emit(PENDING_EDITS_FLUSHED_CHANNEL, {}, id), 10)
    }
  }
  return { t, sent }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('requestRendererFlush', () => {
  it('fragt den Renderer an und erfüllt sich mit seiner Bestätigung', async () => {
    const replies = new EventEmitter()
    const { t, sent } = target(replies)
    const result = requestRendererFlush({ getTargets: () => [t], replies, createId: () => 'r1' })
    await vi.advanceTimersByTimeAsync(10)
    expect(await result).toBe('flushed')
    expect(sent).toEqual([[FLUSH_PENDING_EDITS_CHANNEL, 'r1']])
    expect(replies.listenerCount(PENDING_EDITS_FLUSHED_CHANNEL)).toBe(0)
  })

  it('ignoriert Antworten auf fremde Anfragen', async () => {
    const replies = new EventEmitter()
    const { t } = target(replies, { answer: false })
    const result = requestRendererFlush({ getTargets: () => [t], replies, createId: () => 'r1' })
    replies.emit(PENDING_EDITS_FLUSHED_CHANNEL, {}, 'alt')
    await vi.advanceTimersByTimeAsync(FLUSH_PENDING_EDITS_TIMEOUT_MS)
    expect(await result).toBe('timeout')
  })

  it('wartet höchstens bis zum Zeitlimit', async () => {
    const replies = new EventEmitter()
    const { t } = target(replies, { answer: false })
    let outcome: string | null = null
    void requestRendererFlush({ getTargets: () => [t], replies }).then((o) => (outcome = o))
    await vi.advanceTimersByTimeAsync(FLUSH_PENDING_EDITS_TIMEOUT_MS - 1)
    expect(outcome).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(outcome).toBe('timeout')
    expect(replies.listenerCount(PENDING_EDITS_FLUSHED_CHANNEL)).toBe(0)
  })

  it('geht ohne Fenster bzw. mit zerstörtem Renderer sofort weiter', async () => {
    const replies = new EventEmitter()
    expect(await requestRendererFlush({ getTargets: () => [], replies })).toBe('no-renderer')
    const { t, sent } = target(replies, { destroyed: true })
    expect(await requestRendererFlush({ getTargets: () => [t], replies })).toBe('no-renderer')
    expect(sent).toEqual([])
  })

  it('wirft nie, auch wenn das Senden scheitert', async () => {
    const replies = new EventEmitter()
    const broken: FlushTarget = {
      isDestroyed: () => false,
      send: () => {
        throw new Error('Renderer weg')
      }
    }
    expect(await requestRendererFlush({ getTargets: () => [broken], replies })).toBe('failed')
  })
})

describe('runQuitCleanup', () => {
  it('lässt den Renderer speichern, BEVOR die Datenbank schliesst', async () => {
    const order: string[] = []
    await runQuitCleanup({
      flushRendererEdits: async () => {
        await Promise.resolve()
        order.push('flush')
      },
      cleanupRecording: () => order.push('recording'),
      stopSearchIndex: () => order.push('search'),
      stopSearchModelProvisioner: () => order.push('search-model'),
      stopSourceFileCleanup: () => order.push('cleanup'),
      shutdownTaskQueue: async () => {
        order.push('queue')
      },
      destroyTray: () => order.push('tray'),
      closeDatabase: () => order.push('db')
    })
    expect(order).toEqual([
      'flush',
      'recording',
      'search',
      'search-model',
      'cleanup',
      'queue',
      'tray',
      'db'
    ])
  })

  it('beendet den Suchprozess nach der Aufbereitung und vor der Datenbank (Epic #192)', async () => {
    const order: string[] = []
    await runQuitCleanup({
      flushRendererEdits: async () => order.push('flush'),
      cleanupRecording: () => order.push('recording'),
      stopSearchIndex: () => order.push('search'),
      stopSearchWorker: async () => {
        await Promise.resolve()
        order.push('worker')
      },
      stopSearchModelProvisioner: () => order.push('provisioner'),
      stopSourceFileCleanup: () => order.push('cleanup'),
      shutdownTaskQueue: async () => {
        order.push('queue')
      },
      destroyTray: () => order.push('tray'),
      closeDatabase: () => order.push('db')
    })
    expect(order).toEqual([
      'flush',
      'recording',
      'search',
      'worker',
      'provisioner',
      'cleanup',
      'queue',
      'tray',
      'db'
    ])
  })

  it('schliesst die Datenbank auch, wenn das Speichern im Renderer scheitert', async () => {
    const closeDatabase = vi.fn()
    await runQuitCleanup({
      flushRendererEdits: () => Promise.reject(new Error('kaputt')),
      cleanupRecording: () => {
        throw new Error('nicht initialisiert')
      },
      stopSearchIndex: () => {
        throw new Error('nicht initialisiert')
      },
      stopSearchModelProvisioner: () => {
        throw new Error('nicht initialisiert')
      },
      stopSourceFileCleanup: vi.fn(),
      shutdownTaskQueue: () => Promise.reject(new Error('nicht initialisiert')),
      destroyTray: () => {
        throw new Error('nicht initialisiert')
      },
      closeDatabase
    })
    expect(closeDatabase).toHaveBeenCalledTimes(1)
  })
})
