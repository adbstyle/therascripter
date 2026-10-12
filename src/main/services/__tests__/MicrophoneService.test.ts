import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ systemPreferences: {} }))
vi.mock('../SettingsService', () => ({ getSettings: vi.fn() }))

import {
  dismissMicrophoneHint,
  ensureMicrophoneAccess,
  getMicrophoneState,
  type MicrophoneDeps
} from '../MicrophoneService'
import type { MicrophoneStatus } from '../../../shared/types/Microphone'

function fakeDeps(
  initial: MicrophoneStatus,
  previouslyGranted = false,
  afterAsk: MicrophoneStatus = 'granted'
): MicrophoneDeps & { askForAccess: ReturnType<typeof vi.fn>; granted: () => boolean } {
  let status = initial
  let granted = previouslyGranted
  return {
    getStatus: () => status,
    askForAccess: vi.fn(async () => {
      status = afterAsk
      return afterAsk === 'granted'
    }),
    getPreviouslyGranted: () => granted,
    setPreviouslyGranted: (value) => {
      granted = value
    },
    granted: () => granted
  }
}

describe('getMicrophoneState', () => {
  it('merkt sich eine erteilte Berechtigung', () => {
    const deps = fakeDeps('granted')
    expect(getMicrophoneState(deps)).toEqual({ status: 'granted', previouslyGranted: true })
    expect(deps.granted()).toBe(true)
  })

  it('meldet eine verlorene Berechtigung als «nicht festgelegt, früher erteilt»', () => {
    const deps = fakeDeps('not-determined', true)
    expect(getMicrophoneState(deps)).toEqual({
      status: 'not-determined',
      previouslyGranted: true
    })
  })

  it('setzt «früher erteilt» bei einer Ablehnung nicht zurück', () => {
    const deps = fakeDeps('denied', true)
    expect(getMicrophoneState(deps).previouslyGranted).toBe(true)
  })
})

describe('ensureMicrophoneAccess', () => {
  it('fragt macOS, solange nichts festgelegt ist', async () => {
    const deps = fakeDeps('not-determined')
    expect(await ensureMicrophoneAccess(deps)).toBe('granted')
    expect(deps.askForAccess).toHaveBeenCalledOnce()
    expect(deps.granted()).toBe(true)
  })

  it('liefert die Ablehnung aus der Rückfrage', async () => {
    const deps = fakeDeps('not-determined', false, 'denied')
    expect(await ensureMicrophoneAccess(deps)).toBe('denied')
    expect(deps.granted()).toBe(false)
  })

  it.each<MicrophoneStatus>(['granted', 'denied', 'restricted'])(
    'fragt bei Status %s nicht erneut',
    async (status) => {
      const deps = fakeDeps(status)
      expect(await ensureMicrophoneAccess(deps)).toBe(status)
      expect(deps.askForAccess).not.toHaveBeenCalled()
    }
  )
})

describe('dismissMicrophoneHint', () => {
  it('stuft die Installation auf «nie erteilt» zurück', () => {
    const deps = fakeDeps('not-determined', true)
    dismissMicrophoneHint(deps)
    expect(getMicrophoneState(deps).previouslyGranted).toBe(false)
  })
})
