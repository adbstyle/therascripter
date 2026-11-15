import { rmSync, statfsSync } from 'fs'
import { join } from 'path'
import { powerMonitor } from 'electron'
import { isPublished } from '../../shared/model-catalog'
import type { SearchAvailability, SearchModelState } from '../../shared/types/Search'
import type { SearchWorker } from '../search/SearchWorker'
import { getActiveSessionId } from '../ipc/recording-handlers'
import { sendToRenderer } from '../utils/ipc-helpers'
import {
  checkModelsExist,
  getModelsDir,
  getSearchModelDefinition,
  installCatalogModel,
  isSearchModelInstalled
} from './ModelDownloadService'
import { SearchModelProvisioner } from './SearchModelProvisioner'
import { getTaskQueue } from './TaskQueueService'
import { getSearchRuntime, semanticAvailabilityOf, warmupSearch } from '../search/searchRuntime'
import { getSearchIndexService, type SearchIndexService } from '../search/SearchIndexService'

/** Event an den Renderer, sobald sich die Verfügbarkeit der Suche ändert. */
export const SEARCH_AVAILABILITY_CHANNEL = 'search:availabilityChanged'

let provisioner: SearchModelProvisioner | null = null

function busy(): boolean {
  if (getActiveSessionId() !== null) return true
  try {
    return getTaskQueue().hasWork()
  } catch {
    return false
  }
}

/** Einmal beim Start (nach Reconcile), danach getSearchModelProvisioner(). */
export function initSearchModelProvisioner(): SearchModelProvisioner {
  provisioner = new SearchModelProvisioner({
    getModel: getSearchModelDefinition,
    isPublished,
    isInstalled: isSearchModelInstalled,
    setupComplete: checkModelsExist,
    isBusy: busy,
    freeBytes: () => {
      try {
        const stats = statfsSync(getModelsDir())
        return stats.bavail * stats.bsize
      } catch {
        return null
      }
    },
    install: installCatalogModel,
    removeLeftovers: (def) => {
      const archive = join(getModelsDir(), `${def.id}.tar.gz`)
      for (const path of [archive, `${archive}.partial`]) rmSync(path, { force: true })
    },
    onStateChange: (model) =>
      onSearchModelStateChange(model, {
        worker: getSearchRuntime()?.worker ?? null,
        index: getSearchIndexService(),
        send: sendSearchAvailability
      }),
    now: () => new Date(),
    log: (message) => console.log(message),
    // Nach dem Ruhezustand einen fälligen Versuch nachholen
    subscribeResume: (listener) => powerMonitor.on('resume', listener)
  })
  return provisioner
}

export function getSearchModelProvisioner(): SearchModelProvisioner | null {
  return provisioner
}

/**
 * Gemeinsame Verfügbarkeit der Suche: Stand des Suchmodells (Provisioner,
 * PR S2) und der Suche nach Bedeutung (Verarbeitung, Suchprozess; PR S4).
 */
export function getSearchAvailability(): SearchAvailability {
  const model = provisioner?.getState() ?? { status: 'unpublished' }
  const runtime = getSearchRuntime()
  if (!runtime) return { model, semantic: 'model-missing' }
  const availability: SearchAvailability = {
    model,
    semantic: semanticAvailabilityOf(runtime.worker.getState())
  }
  const message = runtime.worker.getMessage()
  if (message) availability.semanticMessage = message
  return availability
}

/**
 * Modell-Zustand vom Provisioner: ist das Modell (neu) bereit, gelten
 * angehaltene Starts nicht mehr und die Vektorphase läuft sofort an (Bestand,
 * #210 AK 1) — ohne auf den nächsten Takt zu warten. Danach das Event.
 */
export function onSearchModelStateChange(
  model: SearchModelState,
  deps: {
    worker: Pick<SearchWorker, 'resetStartFailures' | 'refreshState'> | null
    index: Pick<SearchIndexService, 'maybeStartVectorPhase'> | null
    send: () => void
  }
): void {
  if (model.status === 'ready') {
    deps.worker?.resetStartFailures()
    deps.index?.maybeStartVectorPhase()
  }
  deps.send()
}

let lastSentAvailability = ''

/**
 * Event `search:availabilityChanged` — nur, wenn sich die Nutzlast ändert
 * (während der Aufbereitung wechselt der Suchprozess pro Batch zwischen
 * `busy` und `ready`; für die Oberfläche ist das derselbe Stand).
 */
export function sendSearchAvailability(): void {
  const availability = getSearchAvailability()
  const key = JSON.stringify(availability)
  if (key === lastSentAvailability) return
  lastSentAvailability = key
  sendToRenderer(SEARCH_AVAILABILITY_CHANNEL, availability)
}

/** Nur für Tests. */
export function resetSentAvailabilityForTests(): void {
  lastSentAvailability = ''
}

/**
 * `search:open`: beim Öffnen der Suche das Suchmodell und parallel die
 * Vektoren vorladen (#209 AK 16) — nur, wenn die Suche nach Bedeutung gerade
 * möglich ist — und den Stand sofort liefern (dann meist `loading`); das
 * Ende des Ladens meldet `search:availabilityChanged`.
 */
export function openSearch(): SearchAvailability {
  const runtime = getSearchRuntime()
  if (runtime) void warmupSearch(runtime)
  return getSearchAvailability()
}
