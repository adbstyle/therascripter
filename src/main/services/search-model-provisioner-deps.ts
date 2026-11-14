import { rmSync, statfsSync } from 'fs'
import { join } from 'path'
import { powerMonitor } from 'electron'
import { isPublished } from '../../shared/model-catalog'
import type { SearchAvailability } from '../../shared/types/Search'
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
import { getSearchIndexService } from '../search/SearchIndexService'

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
    onStateChange: (model) => {
      if (model.status === 'ready') {
        // PR S4: Modell da → Bestand für die Suche nach Bedeutung aufbereiten
        // (#210 AK 1), ohne auf den nächsten Takt zu warten
        getSearchRuntime()?.worker.refreshState()
        getSearchIndexService()?.maybeStartVectorPhase()
      }
      sendSearchAvailability()
    },
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
  const semantic = runtime ? semanticAvailabilityOf(runtime.worker.getState()) : 'model-missing'
  return { model, semantic }
}

/** Event `search:availabilityChanged` — bei jeder Änderung von Modell oder Suchprozess. */
export function sendSearchAvailability(): void {
  sendToRenderer(SEARCH_AVAILABILITY_CHANNEL, getSearchAvailability())
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
