import type Database from 'better-sqlite3'
import { join } from 'path'
import { app } from 'electron'
import { SearchWorker, type SearchWorkerDeps } from './SearchWorker'
import { VectorStore } from './VectorStore'
import { resolveSearchModel } from './searchModel'
import { resolvePythonSidecar } from '../ml/resolve-python'
import { throwIfToolBlocked } from '../services/ToolHealthService'
import { ToolBlockedError } from '../../shared/tool-blocked'
import { onSessionsDeleted } from '../services/ChangeEvents'
import type { VectorPhaseDeps } from './SearchIndexService'
import type { SemanticSearchDeps } from './SearchService'
import type { SearchProcessState, SemanticAvailability } from '../../shared/types/Search'

/**
 * Laufzeit der Suche nach Bedeutung (Epic #192, PR S4): EIN Suchprozess und
 * EIN Vektorspeicher pro App, verdrahtet mit Warteschlange, Löschpfad und
 * Renderer. Initialisiert in main/index.ts.
 */

/** Python für den Suchdienst — in der Entwicklung über THERASCRIPT_SEARCH_PYTHON wählbar. */
export function resolveSearchCommand(): { bin: string; args: string[] } {
  const override = process.env.THERASCRIPT_SEARCH_PYTHON
  if (override && !app.isPackaged) {
    return { bin: override, args: [join(app.getAppPath(), 'python_sidecar', 'search_service.py')] }
  }
  return resolvePythonSidecar('search_service.py')
}

/** Nach einem SIGKILL von aussen: blockiert macOS das Python-Werkzeug? (#168) */
async function isPythonBlocked(exit: { exitSignal: NodeJS.Signals | null }): Promise<boolean> {
  try {
    await throwIfToolBlocked('python', {
      exitSignal: exit.exitSignal,
      timedOut: false,
      aborted: false
    })
    return false
  } catch (error) {
    return error instanceof ToolBlockedError
  }
}

export interface SearchRuntime {
  worker: SearchWorker
  store: VectorStore
  /** Für SearchService. */
  semanticDeps: SemanticSearchDeps
  /** Für SearchIndexService. */
  vectorPhaseDeps: VectorPhaseDeps
  dispose: () => void
}

export interface SearchRuntimeOptions {
  isProcessingActive: () => boolean
  onStateChange?: (state: SearchProcessState) => void
  /** Tests: Abweichungen vom Standard (Fake-Dienst, kürzere Zeiten). */
  workerOverrides?: Partial<SearchWorkerDeps>
}

let runtime: SearchRuntime | null = null

export function createSearchRuntime(
  db: Database.Database,
  options: SearchRuntimeOptions
): SearchRuntime {
  const resolveModel = options.workerOverrides?.resolveModel ?? resolveSearchModel
  const worker = new SearchWorker({
    resolveModel,
    resolveCommand: resolveSearchCommand,
    isProcessingActive: options.isProcessingActive,
    isToolBlocked: isPythonBlocked,
    ...options.workerOverrides
  })
  const store = new VectorStore(db)
  const unsubscribers: Array<() => void> = []
  if (options.onStateChange) unsubscribers.push(worker.onStateChange(options.onStateChange))
  // Arbeitsspeicher frei mit dem Suchprozess (#209 AK 17) — ausser beim
  // Neustart wegen Speicherwachstum, dort folgt der nächste Start sofort
  unsubscribers.push(
    worker.onStopped((reason) => {
      if (reason !== 'memory') store.release()
    })
  )
  // Gelöschte bzw. zum Löschen markierte Sitzungen sofort aus dem Speicher
  unsubscribers.push(
    onSessionsDeleted((ids) => {
      for (const id of ids) store.removeSession(id)
    })
  )
  return {
    worker,
    store,
    semanticDeps: {
      embedQuery: (text) => worker.embedQuery(text),
      getState: () => worker.getState(),
      store,
      resolveModel
    },
    vectorPhaseDeps: {
      resolveModel,
      isProcessingActive: options.isProcessingActive,
      embedDocuments: (texts) => worker.embedDocuments(texts),
      onSessionVectorsChanged: (id) => store.refreshSession(id),
      onTick: () => worker.refreshState()
    },
    dispose: () => {
      for (const off of unsubscribers) off()
    }
  }
}

export function initSearchRuntime(
  db: Database.Database,
  options: SearchRuntimeOptions
): SearchRuntime {
  runtime?.dispose()
  runtime = createSearchRuntime(db, options)
  return runtime
}

/** null, solange nicht initialisiert (Tests, früher Start). */
export function getSearchRuntime(): SearchRuntime | null {
  return runtime
}

/** Nur für Tests. */
export function resetSearchRuntimeForTests(): void {
  runtime?.dispose()
  runtime = null
}

/** Prozesszustand → `SearchAvailability.semantic`. */
export function semanticAvailabilityOf(state: SearchProcessState): SemanticAvailability {
  switch (state.reason) {
    case 'processing':
      return 'unavailable-processing'
    case 'model-missing':
      return 'model-missing'
    case 'tool-blocked':
      return 'tool-blocked'
    case 'error':
      return 'error'
    default:
      return state.phase === 'starting' ? 'loading' : 'ready'
  }
}

/**
 * Vorladen beim Öffnen der Suche (#209 AK 16, über `search:open`): das Modell
 * und parallel die Vektoren — beides nur, wenn die Suche nach Bedeutung
 * gerade möglich ist. Erfüllt sich mit dem Prozesszustand, sobald der Start
 * entschieden ist; wirft nie. Der Start setzt die Phase `starting` noch
 * synchron, ein direkt danach gelesener Stand meldet also `loading`.
 */
export async function warmupSearch(rt: SearchRuntime): Promise<SearchProcessState> {
  const model = rt.semanticDeps.resolveModel()
  if (rt.worker.getState().reason === null && model) {
    const loading = rt.store.load(model.modelId).catch((error) => {
      console.error('[Search] Vektoren nicht geladen:', error)
    })
    try {
      await rt.worker.ensureStarted('warmup')
    } catch {
      // Grund steht im Zustand
    }
    await loading
  }
  return rt.worker.getState()
}
