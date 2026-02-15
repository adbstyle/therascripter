import { ipcMain } from 'electron'
import { getDatabase } from '../db/connection'
import { ReviewService } from '../services/ReviewService'
import { ReviewLoadSchema, ReviewSaveSchema } from '../../shared/validation/review-schemas'
import type { EntityMap } from '../../shared/types'

export function registerReviewHandlers(): void {
  ipcMain.handle('review:load', (_event, args: unknown) => {
    const { sessionId } = ReviewLoadSchema.parse(args)
    const service = new ReviewService(getDatabase())
    return service.load(sessionId)
  })

  ipcMain.handle('review:save', (_event, args: unknown) => {
    const { sessionId, document, entityMap } = ReviewSaveSchema.parse(args)
    const service = new ReviewService(getDatabase())
    service.save(sessionId, document, entityMap as EntityMap)
  })
}
