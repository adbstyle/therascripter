import type { ModelGroup } from '../validation/model-catalog-schemas'

export type ReconcileReason =
  // Active slot pointed to a model whose checkPath was not on disk.
  | 'model-removed'
  // Required slot was null/missing and the catalog default IS installed —
  // promoted the default into the active slot.
  | 'default-promoted'
  // Optional slot had a missing model and was cleared to null (no replacement).
  | 'group-cleared'

export interface ReconcileEvent {
  /** ULID-ish unique id; generated via crypto.randomUUID(). */
  id: string
  /** ISO 8601 timestamp of when the reconciler observed the inconsistency. */
  timestamp: string
  group: ModelGroup
  fromModelId: string | null
  toModelId: string | null
  reason: ReconcileReason
  /**
   * Lifecycle:
   *   pending → reconciler wrote it, BottomNav shows the dot
   *   seen    → renderer mounted Settings → Modelle, dot dismissed but banner still visible
   *   (deletion) → user clicked "Verstanden", entry removed from settings store
   */
  status: 'pending' | 'seen'
}
