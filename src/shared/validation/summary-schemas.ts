import { z } from 'zod'

const MAX_TITLE_CHARS = 120
const MAX_SUMMARY_CHARS = 2_000

export const SummaryGetInputSchema = z.object({
  sessionId: z.string().min(1)
})

export const SummaryUpdateTitleInputSchema = z.object({
  sessionId: z.string().min(1),
  title: z.string().max(MAX_TITLE_CHARS)
})

export const SummaryUpdateTextInputSchema = z.object({
  sessionId: z.string().min(1),
  text: z.string().max(MAX_SUMMARY_CHARS)
})

export type SummaryGetInput = z.infer<typeof SummaryGetInputSchema>
export type SummaryUpdateTitleInput = z.infer<typeof SummaryUpdateTitleInputSchema>
export type SummaryUpdateTextInput = z.infer<typeof SummaryUpdateTextInputSchema>
