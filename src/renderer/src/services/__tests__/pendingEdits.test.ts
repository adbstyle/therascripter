import { describe, it, expect, vi } from 'vitest'
import { flushPendingEdits, registerPendingEditsFlusher } from '../pendingEdits'

describe('pendingEdits-Registry', () => {
  it('ruft alle angemeldeten Flusher und wartet auf alle', async () => {
    const order: string[] = []
    const offA = registerPendingEditsFlusher(async () => {
      await Promise.resolve()
      order.push('a')
    })
    const offB = registerPendingEditsFlusher(async () => {
      order.push('b')
    })
    await flushPendingEdits()
    expect(order.sort()).toEqual(['a', 'b'])
    offA()
    offB()
  })

  it('lässt einen scheiternden Flusher die anderen nicht aufhalten und wirft nie', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const ok = vi.fn().mockResolvedValue(undefined)
    const offA = registerPendingEditsFlusher(() => Promise.reject(new Error('kaputt')))
    const offB = registerPendingEditsFlusher(ok)
    await expect(flushPendingEdits()).resolves.toBeUndefined()
    expect(ok).toHaveBeenCalled()
    offA()
    offB()
  })

  it('ruft abgemeldete Flusher nicht mehr', async () => {
    const flusher = vi.fn().mockResolvedValue(undefined)
    const off = registerPendingEditsFlusher(flusher)
    off()
    await flushPendingEdits()
    expect(flusher).not.toHaveBeenCalled()
  })
})
