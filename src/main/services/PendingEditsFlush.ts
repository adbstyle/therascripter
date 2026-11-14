import { randomUUID } from 'crypto'
import {
  FLUSH_PENDING_EDITS_CHANNEL,
  PENDING_EDITS_FLUSHED_CHANNEL
} from '../../shared/types/ipc/PendingEditsApi'

/** So lange wartet das Beenden höchstens auf den Renderer. */
export const FLUSH_PENDING_EDITS_TIMEOUT_MS = 3_000

export interface FlushTarget {
  isDestroyed: () => boolean
  send: (channel: string, requestId: string) => void
}

export interface FlushReplySource {
  on: (channel: string, listener: (event: unknown, requestId: unknown) => void) => void
  removeListener: (channel: string, listener: (event: unknown, requestId: unknown) => void) => void
}

export interface FlushDeps {
  /** webContents aller offenen Fenster (auch versteckter). */
  getTargets: () => FlushTarget[]
  replies: FlushReplySource
  timeoutMs?: number
  createId?: () => string
}

export type FlushOutcome = 'flushed' | 'timeout' | 'no-renderer' | 'failed'

/**
 * Fordert den Renderer auf, ausstehende Änderungen (Dossier-Stammdaten,
 * Review-Editor) sofort zu speichern, und wartet auf seine Bestätigung —
 * höchstens `timeoutMs`. Läuft in `before-quit` VOR dem Schliessen der
 * Datenbank und vor einem Update-Tausch.
 *
 * Blockiert das Beenden nie: kein Fenster → sofort weiter; Fehler beim
 * Senden → weiter; keine Antwort → nach dem Zeitlimit weiter. Erfüllt sich
 * immer, wirft nie.
 */
export function requestRendererFlush(deps: FlushDeps): Promise<FlushOutcome> {
  let targets: FlushTarget[]
  try {
    targets = deps.getTargets().filter((t) => !t.isDestroyed())
  } catch {
    return Promise.resolve('failed')
  }
  if (targets.length === 0) return Promise.resolve('no-renderer')

  const requestId = (deps.createId ?? randomUUID)()
  const timeoutMs = deps.timeoutMs ?? FLUSH_PENDING_EDITS_TIMEOUT_MS

  return new Promise<FlushOutcome>((resolve) => {
    let pending = targets.length
    let done = false
    const finish = (outcome: FlushOutcome): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      deps.replies.removeListener(PENDING_EDITS_FLUSHED_CHANNEL, onReply)
      resolve(outcome)
    }
    const onReply = (_event: unknown, id: unknown): void => {
      if (id !== requestId) return
      pending -= 1
      if (pending <= 0) finish('flushed')
    }
    const timer = setTimeout(() => finish('timeout'), timeoutMs)
    deps.replies.on(PENDING_EDITS_FLUSHED_CHANNEL, onReply)
    try {
      for (const target of targets) target.send(FLUSH_PENDING_EDITS_CHANNEL, requestId)
    } catch {
      finish('failed')
    }
  })
}

export interface QuitCleanupSteps {
  flushRendererEdits: () => Promise<unknown>
  cleanupRecording: () => void
  /** Epic #192: Aufbereitung für die Suche anhalten — nach dem Flush, vor der DB. */
  stopSearchIndex: () => void
  /**
   * Epic #192 (PR S4): Suchprozess beenden (stdin-EOF → SIGTERM → SIGKILL,
   * begrenzt) — nach der Aufbereitung, die ihn sonst wieder anfragte, vor
   * der Datenbank. Optional, weil nicht jeder Aufrufer ihn hat.
   */
  stopSearchWorker?: () => Promise<void>
  stopSourceFileCleanup: () => void
  shutdownTaskQueue: () => Promise<void>
  destroyTray: () => void
  closeDatabase: () => void
}

/**
 * Reihenfolge des Aufräumens beim Beenden (vorher inline in `before-quit`):
 * zuerst speichert der Renderer ausstehende Änderungen — solange die
 * Datenbank offen ist —, dann Aufnahme, Aufbereitung für die Suche,
 * Suchprozess, Aufräumdienst, Warteschlange, Tray,
 * zuletzt die Datenbank. Kein Schritt hält die folgenden auf.
 */
export async function runQuitCleanup(steps: QuitCleanupSteps): Promise<void> {
  try {
    await steps.flushRendererEdits()
  } catch {
    // Das Beenden darf am Speichern im Renderer nie scheitern
  }
  const run = (step: () => void): void => {
    try {
      step()
    } catch {
      // Dienst ggf. nicht initialisiert
    }
  }
  run(steps.cleanupRecording)
  run(steps.stopSearchIndex)
  if (steps.stopSearchWorker) {
    try {
      await steps.stopSearchWorker()
    } catch {
      // Ein hängender Suchprozess darf das Beenden nicht aufhalten
    }
  }
  run(steps.stopSourceFileCleanup)
  try {
    await steps.shutdownTaskQueue()
  } catch {
    // TaskQueue may not have been initialized
  }
  run(steps.destroyTray)
  steps.closeDatabase()
}
