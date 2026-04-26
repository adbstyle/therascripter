import { ipcMain } from 'electron'
import type { SummaryRecord } from '../services/SessionService'
import {
  SummaryGetInputSchema,
  SummaryUpdateTitleInputSchema,
  SummaryUpdateTextInputSchema
} from '../../shared/validation/summary-schemas'

export interface SummaryHandlerDeps {
  sessionService: {
    getSummary(id: string): SummaryRecord | null
    updateTitle(id: string, title: string): unknown
    updateSummaryText(id: string, text: string): unknown
  }
}

export function handleSummaryGet(input: unknown, deps: SummaryHandlerDeps): SummaryRecord | null {
  const parsed = SummaryGetInputSchema.parse(input)
  return deps.sessionService.getSummary(parsed.sessionId)
}

export function handleSummaryUpdateTitle(input: unknown, deps: SummaryHandlerDeps): void {
  const parsed = SummaryUpdateTitleInputSchema.parse(input)
  deps.sessionService.updateTitle(parsed.sessionId, parsed.title)
}

export function handleSummaryUpdateText(input: unknown, deps: SummaryHandlerDeps): void {
  const parsed = SummaryUpdateTextInputSchema.parse(input)
  deps.sessionService.updateSummaryText(parsed.sessionId, parsed.text)
}

export function registerSummaryHandlers(deps: SummaryHandlerDeps): void {
  ipcMain.handle('summary:get', (_evt, input: unknown) => handleSummaryGet(input, deps))
  ipcMain.handle('summary:updateTitle', (_evt, input: unknown) =>
    handleSummaryUpdateTitle(input, deps)
  )
  ipcMain.handle('summary:updateText', (_evt, input: unknown) =>
    handleSummaryUpdateText(input, deps)
  )
}
