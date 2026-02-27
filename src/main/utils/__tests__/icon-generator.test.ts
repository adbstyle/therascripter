import { describe, it, expect, vi, beforeEach } from 'vitest'

// Must use vi.hoisted so the variable is available when vi.mock factory runs
const { mockNativeImage } = vi.hoisted(() => ({
  mockNativeImage: {
    setTemplateImage: vi.fn()
  }
}))

vi.mock('electron', () => ({
  nativeImage: {
    createFromBuffer: vi.fn().mockReturnValue(mockNativeImage)
  }
}))

import { generateIdleIcon, generateRecordingIcon } from '../icon-generator'
import { nativeImage } from 'electron'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('icon-generator', () => {
  describe('generateIdleIcon', () => {
    it('creates a valid PNG buffer and returns a NativeImage', () => {
      const result = generateIdleIcon()

      expect(nativeImage.createFromBuffer).toHaveBeenCalledOnce()
      const [buffer, options] = vi.mocked(nativeImage.createFromBuffer).mock.calls[0]

      // Verify PNG signature
      expect(buffer[0]).toBe(137)
      expect(buffer[1]).toBe(80) // 'P'
      expect(buffer[2]).toBe(78) // 'N'
      expect(buffer[3]).toBe(71) // 'G'

      // Verify scale factor
      expect(options).toEqual({ scaleFactor: 2 })

      // Verify template image flag
      expect(mockNativeImage.setTemplateImage).toHaveBeenCalledWith(true)

      expect(result).toBe(mockNativeImage)
    })
  })

  describe('generateRecordingIcon', () => {
    it('creates a valid PNG buffer and returns a NativeImage', () => {
      const result = generateRecordingIcon()

      expect(nativeImage.createFromBuffer).toHaveBeenCalledOnce()
      const [buffer, options] = vi.mocked(nativeImage.createFromBuffer).mock.calls[0]

      // Verify PNG signature
      expect(buffer[0]).toBe(137)
      expect(buffer[1]).toBe(80)
      expect(buffer[2]).toBe(78)
      expect(buffer[3]).toBe(71)

      expect(options).toEqual({ scaleFactor: 2 })
      expect(mockNativeImage.setTemplateImage).toHaveBeenCalledWith(true)
      expect(result).toBe(mockNativeImage)
    })
  })

  it('generates different buffers for idle and recording icons', () => {
    generateIdleIcon()
    const idleBuffer = vi.mocked(nativeImage.createFromBuffer).mock.calls[0][0]

    vi.clearAllMocks()
    generateRecordingIcon()
    const recordingBuffer = vi.mocked(nativeImage.createFromBuffer).mock.calls[0][0]

    // Buffers should be different (outline vs filled)
    expect(Buffer.compare(idleBuffer as Buffer, recordingBuffer as Buffer)).not.toBe(0)
  })
})
