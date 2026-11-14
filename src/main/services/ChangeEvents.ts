import { sendToRenderer } from '../utils/ipc-helpers'

/**
 * Änderungs-Events an den Renderer (Epic #192): `sessions:changed` und
 * `dossiers:changed`, Payload `{ deletedIds }`.
 *
 * Gebündelt per setImmediate: alle Meldungen eines Ticks ergeben pro Kanal
 * genau ein Event, die gelöschten IDs werden vereinigt. Ein Löschen, das viele
 * Sitzungen mitnimmt, löst so keinen Refetch-Sturm aus.
 */

type Channel = 'sessions:changed' | 'dossiers:changed'

/** Obergrenze des Event-Schemas (DossiersChangedSchema, max. 1000 IDs). */
const MAX_IDS_PER_EVENT = 1000

type Sender = (channel: string, data: { deletedIds: string[] }) => void

const pending = new Map<Channel, Set<string>>()
let scheduled = false
let send: Sender = sendToRenderer

function flush(): void {
  scheduled = false
  const batches = [...pending.entries()]
  pending.clear()
  for (const [channel, ids] of batches) {
    const all = [...ids]
    if (all.length === 0) {
      send(channel, { deletedIds: [] })
      continue
    }
    for (let i = 0; i < all.length; i += MAX_IDS_PER_EVENT) {
      send(channel, { deletedIds: all.slice(i, i + MAX_IDS_PER_EVENT) })
    }
  }
}

function enqueue(channel: Channel, deletedIds: readonly string[]): void {
  let ids = pending.get(channel)
  if (!ids) {
    ids = new Set()
    pending.set(channel, ids)
  }
  for (const id of deletedIds) ids.add(id)
  if (!scheduled) {
    scheduled = true
    setImmediate(flush)
  }
}

export function notifySessionsChanged(deletedIds: readonly string[] = []): void {
  enqueue('sessions:changed', deletedIds)
}

export function notifyDossiersChanged(deletedIds: readonly string[] = []): void {
  enqueue('dossiers:changed', deletedIds)
}

/** Nur für Tests: Empfänger ersetzen (Standard: sendToRenderer). */
export function setChangeEventSenderForTests(sender: Sender | null): void {
  send = sender ?? sendToRenderer
}
