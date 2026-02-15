import type { EntityMap, PlaceholderType } from '../../shared/types'
import type { MergedEntity } from '../../shared/types/NerTypes'

/**
 * Build the EntityMap from merged + coreference-resolved entities.
 *
 * - Assigns unique entityIds: "person-1", "ort-2", etc.
 * - Generates placeholders: "[PERSON 1]", "[ORT 2]", etc.
 * - Coreference groups share the same entityId
 * - Type-specific numbering (counters per type)
 */
export function buildEntityMap(entities: MergedEntity[]): EntityMap {
  const entityMap: EntityMap = {}
  const counters: Record<PlaceholderType, number> = {
    PERSON: 0,
    ORT: 0,
    DATUM: 0,
    KONTAKT: 0,
    ORGANISATION: 0,
    MEDIZINISCH: 0,
    SONSTIGES: 0
  }

  // Track canonical text → entityId for coreference groups
  const canonicalToId = new Map<string, string>()

  // Process entities in order of appearance
  for (const entity of entities) {
    const key = entity.canonicalText ?? entity.text
    const lookupKey = `${entity.type}:${key.toLowerCase()}`

    if (canonicalToId.has(lookupKey)) continue // Already assigned

    counters[entity.type]++
    const number = counters[entity.type]
    const entityId = `${entity.type.toLowerCase()}-${number}`

    canonicalToId.set(lookupKey, entityId)

    entityMap[entityId] = {
      original: entity.canonicalText ?? entity.text,
      placeholder: `[${entity.type} ${number}]`,
      type: entity.type,
      source: entity.source
    }
  }

  return entityMap
}

/**
 * Look up the entityId for a given entity text and type.
 * Used when building the TipTap document to find the correct chip for each occurrence.
 */
export function findEntityId(
  entityMap: EntityMap,
  text: string,
  type: PlaceholderType,
  allEntities: MergedEntity[]
): string | null {
  // Find which canonical group this text belongs to
  const entity = allEntities.find(
    (e) => e.type === type && e.text.toLowerCase() === text.toLowerCase()
  )
  const canonical = entity?.canonicalText ?? text

  // Find the entityId that matches this canonical text + type
  for (const [id, entry] of Object.entries(entityMap)) {
    if (entry.type === type && entry.original.toLowerCase() === canonical.toLowerCase()) {
      return id
    }
  }

  return null
}
