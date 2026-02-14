import { describe, it, expect } from 'vitest'
import { SessionDeleteSchema, SessionRenameSchema } from '../session-schemas'

describe('SessionDeleteSchema', () => {
  it('accepts valid input', () => {
    const result = SessionDeleteSchema.parse({ sessionId: 'abc-123' })
    expect(result.sessionId).toBe('abc-123')
  })

  it('rejects empty sessionId', () => {
    expect(() => SessionDeleteSchema.parse({ sessionId: '' })).toThrow()
  })

  it('rejects missing sessionId', () => {
    expect(() => SessionDeleteSchema.parse({})).toThrow()
  })

  it('rejects non-object input', () => {
    expect(() => SessionDeleteSchema.parse('abc-123')).toThrow()
  })
})

describe('SessionRenameSchema', () => {
  it('accepts valid input', () => {
    const result = SessionRenameSchema.parse({ sessionId: 'abc-123', title: 'New Title' })
    expect(result.sessionId).toBe('abc-123')
    expect(result.title).toBe('New Title')
  })

  it('rejects empty title', () => {
    expect(() => SessionRenameSchema.parse({ sessionId: 'abc', title: '' })).toThrow()
  })

  it('rejects title over 200 chars', () => {
    expect(() =>
      SessionRenameSchema.parse({ sessionId: 'abc', title: 'x'.repeat(201) })
    ).toThrow()
  })

  it('accepts title at exactly 200 chars', () => {
    const result = SessionRenameSchema.parse({ sessionId: 'abc', title: 'x'.repeat(200) })
    expect(result.title).toHaveLength(200)
  })
})
