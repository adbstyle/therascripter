import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  nativeTheme: { themeSource: 'system' }
}))

import { readViewMode, writeViewMode } from '../settings-handlers'

describe('view mode settings (#203)', () => {
  it('returns the saved view', () => {
    expect(readViewMode(() => 'plain')).toBe('plain')
    expect(readViewMode(() => 'pseudonymized')).toBe('pseudonymized')
  })

  it('falls back to pseudonymized when nothing or something unknown is saved (AK 11)', () => {
    expect(readViewMode(() => undefined)).toBe('pseudonymized')
    expect(readViewMode(() => 'klartext')).toBe('pseudonymized')
    expect(readViewMode(() => 42)).toBe('pseudonymized')
  })

  it('falls back to pseudonymized when the store cannot be read (AK 11)', () => {
    expect(
      readViewMode(() => {
        throw new Error('settings.json korrupt')
      })
    ).toBe('pseudonymized')
  })

  it('persists only a known view', () => {
    const set = vi.fn()
    writeViewMode({ mode: 'plain' }, set)
    expect(set).toHaveBeenCalledWith('plain')
    expect(() => writeViewMode({ mode: 'alles' }, set)).toThrow()
    expect(() => writeViewMode({}, set)).toThrow()
    expect(set).toHaveBeenCalledTimes(1)
  })
})
