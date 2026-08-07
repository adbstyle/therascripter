import { describe, it, expect } from 'vitest'
import { abortable } from '../abortable'

describe('abortable', () => {
  it('passes through the resolved value when no abort happens', async () => {
    await expect(abortable(Promise.resolve(42))).resolves.toBe(42)
  })

  it('passes through rejections', async () => {
    await expect(abortable(Promise.reject(new Error('inner')), undefined)).rejects.toThrow('inner')
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const never = new Promise<number>(() => {})
    await expect(abortable(never, controller.signal)).rejects.toThrow(/abgebrochen/i)
  })

  it('rejects when the signal aborts while the promise is pending', async () => {
    const controller = new AbortController()
    const never = new Promise<number>(() => {})
    setTimeout(() => controller.abort(), 50)
    const start = Date.now()
    await expect(abortable(never, controller.signal)).rejects.toThrow(/abgebrochen/i)
    expect(Date.now() - start).toBeLessThan(1_000)
  })

  it('removes the abort listener after the promise settles', async () => {
    const controller = new AbortController()
    await abortable(Promise.resolve(1), controller.signal)
    // Nach dem Settle darf ein Abort keine unhandled rejection erzeugen
    controller.abort()
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
})
