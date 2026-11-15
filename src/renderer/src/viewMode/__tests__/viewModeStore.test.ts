import { describe, it, expect, vi, afterEach } from 'vitest'
import { getViewMode, setViewMode, _resetViewModeStoreForTests } from '../viewModeStore'

/** Issue #203 — the renderer's view: known from the first read (AK 12), saved on change (AK 10). */
describe('viewModeStore', () => {
  afterEach(() => {
    _resetViewModeStoreForTests()
  })

  function withApi(viewMode: unknown): void {
    window.api = { viewMode } as unknown as typeof window.api
    _resetViewModeStoreForTests()
  }

  it('starts in the view the preload read from the saved settings (AK 10, 12)', () => {
    withApi({ initial: 'plain', set: vi.fn() })
    expect(getViewMode()).toBe('plain')
  })

  it('starts pseudonymized when no view is known (AK 11)', () => {
    withApi(undefined)
    expect(getViewMode()).toBe('pseudonymized')
    withApi({ initial: 'irgendwas', set: vi.fn() })
    expect(getViewMode()).toBe('pseudonymized')
  })

  it('switches synchronously and saves the choice', () => {
    const set = vi.fn().mockResolvedValue(undefined)
    withApi({ initial: 'pseudonymized', set })
    setViewMode('plain')
    expect(getViewMode()).toBe('plain')
    expect(set).toHaveBeenCalledWith('plain')
  })

  it('keeps the switch for this run when saving fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    withApi({ initial: 'pseudonymized', set: vi.fn().mockRejectedValue(new Error('IPC')) })
    setViewMode('plain')
    await Promise.resolve()
    expect(getViewMode()).toBe('plain')
    error.mockRestore()
  })
})
