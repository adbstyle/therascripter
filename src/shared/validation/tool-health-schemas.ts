import { z } from 'zod'

/** Push toolHealth:state (#168) — Zustand der eingebauten Werkzeuge. */
export const ToolHealthStateSchema = z.object({
  status: z.enum(['checking', 'ok', 'blocked']),
  tools: z.array(z.enum(['whisper', 'python', 'llama', 'ocr'])),
  bundlePath: z.string()
})
