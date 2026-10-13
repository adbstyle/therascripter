import { z } from 'zod'
import { BLOCKED_TOOLS } from '../tool-blocked'

/** Push toolHealth:state (#168) — Zustand der eingebauten Werkzeuge. */
export const ToolHealthStateSchema = z.object({
  status: z.enum(['checking', 'ok', 'blocked']),
  tools: z.array(z.enum(BLOCKED_TOOLS)),
  bundlePath: z.string()
})
