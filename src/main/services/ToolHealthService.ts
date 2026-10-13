import { existsSync } from 'fs'
import { join } from 'path'
import {
  BLOCKED_TOOLS,
  ToolBlockedError,
  type BlockedTool,
  type ToolHealthState
} from '../../shared/tool-blocked'

/**
 * Blockierte Werkzeuge erkennen und beheben (Issue #168, ADR-009 Entscheidung 6).
 *
 * Nach «Dennoch öffnen» trägt jede Datei der App die Freigabe in ihrer
 * Download-Markierung (Flag 0x40). Eine Datei, in die macOS dabei nicht
 * schreiben konnte (fehlendes Schreibrecht), behält die unfreigegebene
 * Markierung — das Werkzeug, das sie lädt, wird beim Start beendet (SIGKILL,
 * ohne Ausgabe).
 *
 * Geprüft werden nur Programmdateien (ausführbare Dateien, .so, .dylib) und
 * schreibgeschützte Dateien — Python-Quelltext und Daten blockiert macOS nie. Das sind ~600 von
 * ~17'000 Dateien, gemessen ~0.1 s. Hat die Nutzer:in die App freigegeben
 * (die App selbst trägt die Freigabe oder gar keine Markierung), entfernt die
 * App die Markierung ihrer eigenen Werkzeuge still (AK 1). Ohne Freigabe nie
 * (Out of Scope 1) — dann erklärt ein Hinweis den Weg (AK 2–4).
 */

const QUARANTINE = 'com.apple.quarantine'
/** QTN_FLAG_USER_APPROVED: von macOS gesetzt, sobald die Nutzer:in die App freigibt. */
const USER_APPROVED = 0x40
/** Argumente pro Aufruf von xattr/chmod — weit unter ARG_MAX. */
const CHUNK = 200

/** Ordner unter Contents/Resources, deren Programmdateien das Werkzeug lädt. */
const TOOL_DIRS: Record<BlockedTool, string[]> = {
  whisper: ['whisper'],
  python: ['ml_sidecar'],
  llama: ['llama'],
  ocr: ['bin']
}

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

export interface ToolHealthDeps {
  isPackaged: boolean
  resourcesPath: string
  bundlePath: string
  /** Contents/MacOS/Therascript — trägt sie die Freigabe, gilt die App als freigegeben. */
  mainExecutable: string
  /** Systemwerkzeug ausführen (find, xattr, chmod) — nie ein eigenes Werkzeug. */
  run: (bin: string, args: string[]) => Promise<RunResult>
  onStateChange: (state: ToolHealthState) => void
  log: (message: string) => void
}

/** Ist die Markierung freigegeben? Ohne Markierung (null) gibt es nichts zu blockieren. */
export function isApprovedQuarantine(value: string | null): boolean {
  if (value === null) return true
  const flags = parseInt(value.split(';')[0], 16)
  return Number.isNaN(flags) || (flags & USER_APPROVED) !== 0
}

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK))
  return out
}

/** Erwartet ist nur das Ergebnis eines Kommandos — Fehler zählen als «nichts gefunden». */
async function tryRun(deps: ToolHealthDeps, bin: string, args: string[]): Promise<RunResult> {
  try {
    return await deps.run(bin, args)
  } catch (err) {
    deps.log(`ToolHealth: ${bin} gescheitert: ${err instanceof Error ? err.message : err}`)
    return { code: null, stdout: '', stderr: '' }
  }
}

export class ToolHealthService {
  private state: ToolHealthState
  private readyPromise: Promise<void> = Promise.resolve()
  /** Letzte Prüfung — Prüfungen laufen nacheinander, sonst überschriebe eine die andere. */
  private lastCheck: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: ToolHealthDeps) {
    this.state = {
      status: deps.isPackaged ? 'checking' : 'ok',
      tools: [],
      bundlePath: deps.bundlePath
    }
  }

  getState(): ToolHealthState {
    return this.state
  }

  /** Erfüllt, sobald die Startprüfung (samt Reparatur) durch ist. */
  ready(): Promise<void> {
    return this.readyPromise
  }

  /** Startprüfung aller Werkzeuge; behebt still, was sich beheben lässt (AK 1). */
  check(): Promise<void> {
    this.readyPromise = this.checkTools(BLOCKED_TOOLS).then(() => undefined)
    return this.readyPromise
  }

  /**
   * Nach einem SIGKILL eines Werkzeugs: blockiert? Dann (wenn erlaubt)
   * beheben. 'none' = keine Blockade, der Fehler hat einen anderen Grund
   * (z. B. Speichermangel) und bleibt, wie er ist.
   */
  async recheck(tool: BlockedTool): Promise<'none' | 'repaired' | 'blocked'> {
    const { found, stillBlocked } = await this.checkTools([tool])
    if (!found.includes(tool)) return 'none'
    return stillBlocked.includes(tool) ? 'blocked' : 'repaired'
  }

  /**
   * Prüft die Werkzeuge, behebt wenn erlaubt. found: was blockiert war,
   * stillBlocked: was es danach noch ist. Läuft nach einer laufenden Prüfung.
   */
  private checkTools(
    tools: readonly BlockedTool[]
  ): Promise<{ found: BlockedTool[]; stillBlocked: BlockedTool[] }> {
    const run = this.lastCheck.then(() => this.runCheck(tools))
    this.lastCheck = run.catch(() => undefined)
    return run
  }

  private async runCheck(
    tools: readonly BlockedTool[]
  ): Promise<{ found: BlockedTool[]; stillBlocked: BlockedTool[] }> {
    if (!this.deps.isPackaged) return { found: [], stillBlocked: [] }
    const blocked = new Map<BlockedTool, string[]>()
    for (const tool of tools) {
      const files = await this.blockedFiles(tool)
      if (files.length > 0) blocked.set(tool, files)
    }
    const found = [...blocked.keys()]
    if (blocked.size > 0 && (await this.appApproved())) {
      const files = [...blocked.values()].flat()
      this.deps.log(`ToolHealth: ${files.length} blockierte Programmdateien — behebe still`)
      await this.repair(files)
      for (const tool of [...blocked.keys()]) {
        if ((await this.blockedFiles(tool)).length === 0) blocked.delete(tool)
      }
    }
    const stillBlocked = [...blocked.keys()]
    if (stillBlocked.length > 0) {
      this.deps.log(`ToolHealth: blockiert, nicht behebbar: ${stillBlocked.join(', ')}`)
    }
    const others = this.state.tools.filter((t) => !tools.includes(t))
    const all = BLOCKED_TOOLS.filter((t) => others.includes(t) || stillBlocked.includes(t))
    this.state = {
      status: all.length > 0 ? 'blocked' : 'ok',
      tools: all,
      bundlePath: this.deps.bundlePath
    }
    this.deps.onStateChange(this.state)
    return { found, stillBlocked }
  }

  /** Programmdateien eines Werkzeugs, deren Markierung keine Freigabe trägt. */
  private async blockedFiles(tool: BlockedTool): Promise<string[]> {
    const dirs = TOOL_DIRS[tool]
      .map((dir) => join(this.deps.resourcesPath, dir))
      .filter((dir) => existsSync(dir))
    if (dirs.length === 0) return []
    const found = await tryRun(this.deps, '/usr/bin/find', [
      ...dirs,
      '-type',
      'f',
      '(',
      '-name',
      '*.so',
      '-o',
      '-name',
      '*.dylib',
      '-o',
      '-perm',
      '-u+x',
      // Schreibgeschützte Dateien sind die eigentliche Ursache — immer mitprüfen
      '-o',
      '!',
      '-perm',
      '-u+w',
      ')',
      '-print0'
    ])
    const files = found.stdout.split('\0').filter(Boolean)
    const marks = await this.readQuarantine(files)
    return files.filter((file) => !isApprovedQuarantine(marks.get(file) ?? null))
  }

  /** Markierung je Datei; Dateien ohne Markierung fehlen in der Map. */
  private async readQuarantine(files: string[]): Promise<Map<string, string>> {
    const marks = new Map<string, string>()
    for (const batch of chunks(files)) {
      const result = await tryRun(this.deps, '/usr/bin/xattr', ['-p', QUARANTINE, ...batch])
      if (batch.length === 1) {
        // Bei einer einzelnen Datei druckt xattr nur den Wert
        if (result.code === 0 && result.stdout.trim()) marks.set(batch[0], result.stdout.trim())
        continue
      }
      for (const line of result.stdout.split('\n')) {
        const at = line.lastIndexOf(': ')
        if (at > 0) marks.set(line.slice(0, at), line.slice(at + 2).trim())
      }
    }
    return marks
  }

  /** Hat die Nutzer:in die App freigegeben? Nur dann darf die App reparieren. */
  private async appApproved(): Promise<boolean> {
    const marks = await this.readQuarantine([this.deps.mainExecutable])
    return isApprovedQuarantine(marks.get(this.deps.mainExecutable) ?? null)
  }

  /** Schreibrecht zurück (sonst lehnt xattr ab), dann die unfreigegebene Markierung entfernen. */
  private async repair(files: string[]): Promise<void> {
    for (const batch of chunks(files)) {
      await tryRun(this.deps, '/bin/chmod', ['u+w', ...batch])
      await tryRun(this.deps, '/usr/bin/xattr', ['-d', QUARANTINE, ...batch])
    }
  }
}

/**
 * Startprüfung anwerfen und die Verarbeitung darauf warten lassen — höchstens
 * `capMs`, danach läuft sie trotzdem an. Die Oberfläche wartet nie (NFR 1).
 */
export function startToolCheck(
  service: Pick<ToolHealthService, 'check'>,
  queue: { holdUntil(gate: Promise<unknown>): void },
  capMs = 10_000
): void {
  const cap = new Promise<void>((resolve) => setTimeout(resolve, capMs).unref?.())
  queue.holdUntil(Promise.race([service.check(), cap]))
}

// ── Für die Werkzeug-Aufrufe ──────────────────────────────────────────────

let service: ToolHealthService | null = null

export function setToolHealthService(instance: ToolHealthService | null): void {
  service = instance
}

export function getToolHealthService(): ToolHealthService | null {
  return service
}

/**
 * Nach einem fehlgeschlagenen Werkzeug-Aufruf: Wurde das Werkzeug von aussen
 * beendet (SIGKILL ohne eigenen Timeout/Abbruch) und ist es blockiert, wirft
 * das einen ToolBlockedError mit verständlicher Meldung statt «Exit Code
 * null» (PC 1). Sonst kehrt es zurück und der Aufrufer meldet wie bisher.
 */
export async function throwIfToolBlocked(
  tool: BlockedTool,
  result: { exitSignal: NodeJS.Signals | null; timedOut: boolean; aborted: boolean }
): Promise<void> {
  if (result.exitSignal !== 'SIGKILL' || result.timedOut || result.aborted) return
  const outcome = (await service?.recheck(tool)) ?? 'none'
  if (outcome !== 'none') throw new ToolBlockedError(tool, outcome === 'repaired')
}
