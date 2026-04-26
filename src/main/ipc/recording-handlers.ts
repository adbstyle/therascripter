import { ipcMain, Notification, powerSaveBlocker } from 'electron'
import { getDatabase } from '../db/connection'
import { SessionService } from '../services/SessionService'
import { AudioFileService } from '../services/AudioFileService'
import { getTray } from '../services/TrayService'
import { getTaskQueue } from '../services/TaskQueueService'
import { RecordingStopSchema, RecordingDataSchema } from '../../shared/validation/recording-schemas'
import { sendToRenderer } from '../utils/ipc-helpers'

const AUTO_STOP_MS = 7200 * 1000 // 2 hours

const audioFileService = new AudioFileService()
let durationInterval: ReturnType<typeof setInterval> | null = null
let recordingStartTime: number | null = null
let activeSessionId: string | null = null
let powerBlockerId: number | null = null
let autoStopTimer: ReturnType<typeof setTimeout> | null = null

function generateTitle(): string {
  const now = new Date()
  const day = now.getDate().toString().padStart(2, '0')
  const month = (now.getMonth() + 1).toString().padStart(2, '0')
  const year = now.getFullYear()
  const hours = now.getHours().toString().padStart(2, '0')
  const minutes = now.getMinutes().toString().padStart(2, '0')
  return `Aufnahme ${day}.${month}.${year} ${hours}:${minutes}`
}

function startPowerBlocker(): void {
  if (powerBlockerId !== null) return
  try {
    powerBlockerId = powerSaveBlocker.start('prevent-app-suspension')
  } catch {
    // Non-critical: log but don't block recording
  }
}

function stopPowerBlocker(): void {
  if (powerBlockerId !== null) {
    try {
      powerSaveBlocker.stop(powerBlockerId)
    } catch {
      // Best effort cleanup
    }
    powerBlockerId = null
  }
}

function stopDurationTimer(): void {
  if (durationInterval !== null) {
    clearInterval(durationInterval)
    durationInterval = null
  }
  recordingStartTime = null
}

function clearAutoStopTimer(): void {
  if (autoStopTimer !== null) {
    clearTimeout(autoStopTimer)
    autoStopTimer = null
  }
}

function stopRecordingInternal(sessionId: string): { durationSeconds: number } {
  stopDurationTimer()
  clearAutoStopTimer()
  stopPowerBlocker()

  const { durationSeconds } = audioFileService.finalizeWavFile(sessionId)

  const service = new SessionService(getDatabase())
  service.updateSession(sessionId, { status: 'transcribing' })

  // Enqueue ML pipeline tasks for sequential processing
  try {
    getTaskQueue().enqueuePipeline(sessionId, 'audio')
  } catch {
    // TaskQueue may not be initialized in tests
  }

  activeSessionId = null

  try {
    getTray().setRecordingState(false)
  } catch {
    // Tray may not be initialized in tests
  }

  return { durationSeconds }
}

function autoStopRecording(): void {
  if (!activeSessionId) return

  const sessionId = activeSessionId
  try {
    stopRecordingInternal(sessionId)
  } catch {
    // Best effort
  }

  // Notify renderer
  sendToRenderer('recording:auto-stopped')

  // Show macOS notification
  try {
    new Notification({
      title: 'Aufnahme gestoppt',
      body: 'Die Aufnahme wurde automatisch nach 2 Stunden gestoppt.'
    }).show()
  } catch {
    // Notifications may be disabled by user
  }
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

    // Start power save blocker (NFR-24)
    startPowerBlocker()

    // Start duration timer (1 Hz) — updates renderer + tray
    durationInterval = setInterval(() => {
      if (recordingStartTime === null) return
      const seconds = Math.floor((Date.now() - recordingStartTime) / 1000)
      sendToRenderer('recording:duration', { seconds })
      try {
        getTray().updateDuration(seconds)
      } catch {
        // Tray may not be initialized in tests
      }
    }, 1000)

    // Start 2h auto-stop timer (main process safety net)
    autoStopTimer = setTimeout(autoStopRecording, AUTO_STOP_MS)

    // Update tray icon
    try {
      getTray().setRecordingState(true)
    } catch {
      // Tray may not be initialized in tests
    }

    return { sessionId: session.id }
  })

  ipcMain.handle('recording:stop', (_event, args: unknown) => {
    const { sessionId } = RecordingStopSchema.parse(args)

    if (activeSessionId !== sessionId) {
      throw new Error(`Session ${sessionId} is not the active recording`)
    }

    return stopRecordingInternal(sessionId)
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
    clearAutoStopTimer()
    stopPowerBlocker()
    activeSessionId = null
  }
}

export function stopRecordingFromTray(): void {
  if (!activeSessionId) return
  try {
    stopRecordingInternal(activeSessionId)
    sendToRenderer('recording:auto-stopped')
  } catch {
    // Best effort
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
