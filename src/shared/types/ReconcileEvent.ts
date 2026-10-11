import type { ModelGroup } from '../validation/model-catalog-schemas'

export type ReconcileReason =
  // Active slot pointed to a model whose checkPath was not on disk.
  | 'model-removed'
  // Required slot was null/missing and the catalog default IS installed —
  // promoted the default into the active slot.
  | 'default-promoted'
  // Optional slot had a missing model and was cleared to null (no replacement).
  | 'group-cleared'
  // Active model was removed from the catalog (RETIRED_MODELS); its file was
  // deleted at startup and the slot cleared. The successor must be downloaded.
  | 'model-retired'

export interface ReconcileEvent {
  /** ULID-ish unique id; generated via crypto.randomUUID(). */
  id: string
  /** ISO 8601 timestamp of when the reconciler observed the inconsistency. */
  timestamp: string
  group: ModelGroup
  fromModelId: string | null
  toModelId: string | null
  /**
   * Display names captured when the event was written — a retired model is no
   * longer in the catalog, so the renderer could not resolve its id. Optional:
   * events persisted by older versions have none (banner falls back to the id).
   */
  fromLabel?: string | null
  toLabel?: string | null
  reason: ReconcileReason
  /**
   * Lifecycle:
   *   pending → reconciler wrote it, BottomNav shows the dot
   *   seen    → renderer mounted Settings → Modelle, dot dismissed but banner still visible
   *   (deletion) → user clicked "Verstanden", entry removed from settings store
   */
  status: 'pending' | 'seen'
}
