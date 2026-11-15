import { ipcRenderer } from 'electron'
import type { RecentApi } from '../../shared/types/ipc/RecentApi'
import { RecentChangedSchema } from '../../shared/validation/change-event-schemas'
import { SKIP, createChannel } from './channelHub'

const onRecentChanged = createChannel('recent:changed', (raw) =>
  RecentChangedSchema.safeParse(raw).success ? true : SKIP
)

/** «Zuletzt geöffnet» (#213). Eingehende Events werden mit Zod geprüft. */
export const recentApi: RecentApi = {
  list: () => ipcRenderer.invoke('recent:list'),
  touch: (target) => ipcRenderer.invoke('recent:touch', target),
  onChanged: (callback) => onRecentChanged(() => callback())
}
