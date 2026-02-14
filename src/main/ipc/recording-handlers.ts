import { BrowserWindow, ipcMain } from 'electron'
import { getDatabase } from '../db/connection'
import { SessionService } from '../services/SessionService'
import { AudioFileService } from '../services/AudioFileService'
import { RecordingStopSchema, RecordingDataSchema } from '../../shared/validation/recording-schemas'

const audioFileService = new AudioFileService()
let durationInterval: ReturnType<typeof setInterval> | null = null
let recordingStartTime: number | null = null
let activeSessionId: string | null = null

function generateTitle(): string {
  const now = new Date()
  const day = now.getDate().toString().padStart(2, '0')
  const month = (now.getMonth() + 1).toString().padStart(2, '0')
  const year = now.getFullYear()
  const hours = now.getHours().toString().padStart(2, '0')
  const minutes = now.getMinutes().toString().padStart(2, '0')
  return `Sitzung ${day}.${month}.${year} ${hours}:${minutes}`
}

function sendToRenderer(channel: string, data: unknown): void {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    win.webContents.send(channel, data)
  }
}

function stopDurationTimer(): void {
  if (durationInterval !== null) {
    clearInterval(durationInterval)
    durationInterval = null
  }
  recordingStartTime = null
  activeSessionId = null
}

export function getActiveSessionId(): string | null {
  return activeSessionId
}

export function getAudioFileService(): AudioFileService {
  return audioFileService
}

export function registerRecordingHandlers(): void {
  ipcMain.handle('recording:start', () => {
    if (activeSessionId) {
      throw new Error('A recording is already in progress')
    }

    const service = new SessionService(getDatabase())
    const title = generateTitle()
    const session = service.createSession(title, 'audio')

    const wavPath = audioFileService.initWavFile(session.id)
    service.updateSession(session.id, { audioPath: wavPath })

    activeSessionId = session.id
    recordingStartTime = Date.now()

    // Start duration timer (1 Hz)
    durationInterval = setInterval(() => {
      if (recordingStartTime === null) return
      const seconds = Math.floor((Date.now() - recordingStartTime) / 1000)
      sendToRenderer('recording:duration', { seconds })
    }, 1000)

    return { sessionId: session.id }
  })

  ipcMain.handle('recording:stop', (_event, args: unknown) => {
    const { sessionId } = RecordingStopSchema.parse(args)

    if (activeSessionId !== sessionId) {
      throw new Error(`Session ${sessionId} is not the active recording`)
    }

    stopDurationTimer()

    const { durationSeconds } = audioFileService.finalizeWavFile(sessionId)

    const service = new SessionService(getDatabase())
    service.updateSession(sessionId, { status: 'transcribing' })

    return { durationSeconds }
  })

  ipcMain.on('recording:data', (_event, args: unknown) => {
    const { sessionId, samples } = RecordingDataSchema.parse(args)

    if (activeSessionId !== sessionId) return

    try {
      audioFileService.appendChunk(sessionId, samples)
    } catch (error) {
      sendToRenderer('recording:error', {
        message: error instanceof Error ? error.message : 'Fehler beim Schreiben der Audiodaten'
      })
    }
  })

}

export function cleanupRecordingOnQuit(): void {
  if (activeSessionId) {
    try {
      audioFileService.finalizeWavFile(activeSessionId)
      const service = new SessionService(getDatabase())
      service.updateSession(activeSessionId, {
        status: 'error',
        errorMessage: 'Aufnahme wurde durch App-Beendigung unterbrochen'
      })
    } catch {
      // Best effort cleanup on quit
    }
    stopDurationTimer()
  }
}

export function checkForRecovery(): Array<{ sessionId: string; title: string }> {
  const service = new SessionService(getDatabase())
  const sessions = service.getAllSessions()
  const stuckRecordings: Array<{ sessionId: string; title: string }> = []

  for (const session of sessions) {
    if (session.status === 'recording') {
      stuckRecordings.push({ sessionId: session.id, title: session.title })
    }
  }

  return stuckRecordings
}
