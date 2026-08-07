import { BrowserWindow } from 'electron'
import type { z } from 'zod'

export function sendToRenderer(channel: string, data?: unknown): void {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    win.webContents.send(channel, data)
  }
}

/**
 * Zod-Validierung für IPC-Payloads mit kanal-präfixierter deutscher
 * Fehlermeldung. War verbatim dupliziert in model-catalog-handlers und
 * pipeline-handlers — hier der gemeinsame Ort für alle Handler.
 */
export function validateIpc<T>(schema: z.ZodType<T>, payload: unknown, channel: string): T {
  const parsed = schema.safeParse(payload)
  if (!parsed.success) {
    throw new Error(`IPC ${channel}: ungültige Argumente: ${parsed.error.message}`)
  }
  return parsed.data
}
