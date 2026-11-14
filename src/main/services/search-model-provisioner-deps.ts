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
      const availability: SearchAvailability = { model }
      sendToRenderer(SEARCH_AVAILABILITY_CHANNEL, availability)
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

/** Antwort von `search:open` (PR S4 ergänzt Verarbeitung und Suchprozess). */
export function getSearchAvailability(): SearchAvailability {
  return { model: provisioner?.getState() ?? { status: 'unpublished' } }
}
