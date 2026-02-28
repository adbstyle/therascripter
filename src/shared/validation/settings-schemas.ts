import { z } from 'zod'

const settingsKeySchema = z.enum([
  'activeModels',
  'firstLaunchDone',
  'consentReminderShown',
  'modelsDownloaded',
  'theme'
])

export const SettingsGetSchema = z.object({
  key: settingsKeySchema
})

export const SettingsSetSchema = z.object({
  key: settingsKeySchema,
  value: z.unknown()
})

export type SettingsGetInput = z.infer<typeof SettingsGetSchema>
export type SettingsSetInput = z.infer<typeof SettingsSetSchema>
