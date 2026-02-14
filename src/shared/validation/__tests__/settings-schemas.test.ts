import { describe, it, expect } from 'vitest'
import { SettingsGetSchema, SettingsSetSchema } from '../settings-schemas'

describe('SettingsGetSchema', () => {
  it('validates known setting keys', () => {
    expect(SettingsGetSchema.parse({ key: 'consentReminderShown' })).toEqual({
      key: 'consentReminderShown'
    })
    expect(SettingsGetSchema.parse({ key: 'firstLaunchDone' })).toEqual({
      key: 'firstLaunchDone'
    })
    expect(SettingsGetSchema.parse({ key: 'activeModels' })).toEqual({
      key: 'activeModels'
    })
    expect(SettingsGetSchema.parse({ key: 'modelsDownloaded' })).toEqual({
      key: 'modelsDownloaded'
    })
  })

  it('rejects unknown keys', () => {
    expect(() => SettingsGetSchema.parse({ key: 'unknownKey' })).toThrow()
  })

  it('rejects missing key', () => {
    expect(() => SettingsGetSchema.parse({})).toThrow()
  })

  it('rejects non-object input', () => {
    expect(() => SettingsGetSchema.parse('consentReminderShown')).toThrow()
  })
})

describe('SettingsSetSchema', () => {
  it('validates key + boolean value', () => {
    const result = SettingsSetSchema.parse({
      key: 'consentReminderShown',
      value: true
    })
    expect(result).toEqual({ key: 'consentReminderShown', value: true })
  })

  it('validates key + object value', () => {
    const result = SettingsSetSchema.parse({
      key: 'activeModels',
      value: { transcription: 'whisper-large-v3-turbo' }
    })
    expect(result.key).toBe('activeModels')
  })

  it('rejects unknown keys', () => {
    expect(() =>
      SettingsSetSchema.parse({ key: 'badKey', value: true })
    ).toThrow()
  })

  it('accepts missing value (z.unknown() allows undefined)', () => {
    const result = SettingsSetSchema.parse({ key: 'firstLaunchDone' })
    expect(result.key).toBe('firstLaunchDone')
  })
})
