import { ipcMain } from 'electron'
import { getTaskQueue } from '../services/TaskQueueService'
import { GetSessionTasksSchema } from '../../shared/validation/task-schemas'
import { stripAbsolutePaths } from '../utils/userFacingError'

export function registerTaskHandlers(): void {
  ipcMain.handle('task:getSessionTasks', (_event, args: unknown) => {
    const { sessionId } = GetSessionTasksSchema.parse(args)
    // Task.error enthält die vollständige Meldung (Log); der Renderer bekommt
    // sie ohne absolute Pfade wie die Sitzungskarte
    return getTaskQueue()
      .getSessionTasks(sessionId)
      .map((task) => (task.error ? { ...task, error: stripAbsolutePaths(task.error) } : task))
  })

  ipcMain.handle('task:isProcessing', () => {
    return getTaskQueue().isProcessing()
  })

  ipcMain.handle('task:retry', (_event, args: unknown) => {
    const { sessionId } = GetSessionTasksSchema.parse(args)
    getTaskQueue().retrySession(sessionId)
  })
}
