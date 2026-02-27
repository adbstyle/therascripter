import { describe, it, expect } from 'vitest'
import { RecordingStopSchema, RecordingDataSchema } from '../recording-schemas'

describe('RecordingStopSchema', () => {
  it('validates valid input', () => {
    const result = RecordingStopSchema.parse({ sessionId: 'abc-123' })
    expect(result.sessionId).toBe('abc-123')
  })

  it('rejects empty sessionId', () => {
    expect(() => RecordingStopSchema.parse({ sessionId: '' })).toThrow()
  })

  it('rejects missing sessionId', () => {
    expect(() => RecordingStopSchema.parse({})).toThrow()
  })
})

describe('RecordingDataSchema', () => {
  it('validates valid input with ArrayBuffer', () => {
    const buffer = new ArrayBuffer(16)
    const result = RecordingDataSchema.parse({ sessionId: 'abc-123', samples: buffer })
    expect(result.sessionId).toBe('abc-123')
    expect(result.samples).toBe(buffer)
  })

  it('rejects non-ArrayBuffer samples', () => {
    expect(() =>
      RecordingDataSchema.parse({ sessionId: 'abc-123', samples: 'not a buffer' })
    ).toThrow()
  })
})
