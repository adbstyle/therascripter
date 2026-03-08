import { ipcMain } from 'electron'
import { getTaskQueue } from '../services/TaskQueueService'
import { GetSessionTasksSchema } from '../../shared/validation/task-schemas'

export function registerTaskHandlers(): void {
  ipcMain.handle('task:getSessionTasks', (_event, args: unknown) => {
    const { sessionId } = GetSessionTasksSchema.parse(args)
    return getTaskQueue().getSessionTasks(sessionId)
  })

  ipcMain.handle('task:isProcessing', () => {
    return getTaskQueue().isProcessing()
  })

  ipcMain.handle('task:retry', (_event, args: unknown) => {
    const { sessionId } = GetSessionTasksSchema.parse(args)
    getTaskQueue().retrySession(sessionId)
  })
}
