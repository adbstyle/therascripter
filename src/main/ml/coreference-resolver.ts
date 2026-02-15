import type { MergedEntity } from '../../shared/types/NerTypes'

const TITLE_PREFIXES = ['herr', 'frau', 'dr.', 'dr', 'prof.', 'prof', 'hr.', 'fr.']

/**
 * Extract canonical name form by stripping title prefixes and normalizing.
 * "Dr. Müller" → "müller"
 * "Herr Peter Schmidt" → "peter schmidt"
 * "Prof. Dr. Weber" → "weber"
 */
export function getCanonicalName(name: string): string {
  let cleaned = name.trim().toLowerCase()

  // Strip all title prefixes iteratively (handles "Prof. Dr. Name")
  let changed = true
  while (changed) {
    changed = false
    for (const title of TITLE_PREFIXES) {
      if (cleaned.startsWith(title + ' ')) {
        cleaned = cleaned.substring(title.length).trimStart()
        changed = true
      }
    }
  }

  return cleaned.trim()
}

/**
 * Check if nameA is a substring/variant of nameB or vice versa.
 * "müller" matches "peter müller" (surname contained in full name).
 */
function namesMatch(canonicalA: string, canonicalB: string): boolean {
  if (canonicalA === canonicalB) return true

  // Check if one is a suffix of the other (surname matching)
  const partsA = canonicalA.split(/\s+/)
  const partsB = canonicalB.split(/\s+/)

  // Single name matches as surname in multi-part name
  if (partsA.length === 1 && partsB.length > 1) {
    return partsB[partsB.length - 1] === canonicalA
  }
  if (partsB.length === 1 && partsA.length > 1) {
    return partsA[partsA.length - 1] === canonicalB
  }

  // Both multi-part: check if surnames match
  if (partsA.length > 1 && partsB.length > 1) {
    return partsA[partsA.length - 1] === partsB[partsB.length - 1]
  }

  return false
}

/**
 * Resolve coreferences for PERSON entities.
 * Groups name variants (e.g., "Dr. Müller", "Müller", "Herr Müller")
 * and assigns the same canonicalText for consistent placeholder assignment.
 *
 * The longest variant is used as the canonical representative.
 */
export function resolveCoreferences(entities: MergedEntity[]): MergedEntity[] {
  const personEntities = entities.filter((e) => e.type === 'PERSON')
  const otherEntities = entities.filter((e) => e.type !== 'PERSON')

  if (personEntities.length === 0) return entities

  // Build groups of matching names
  const groups: MergedEntity[][] = []

  for (const entity of personEntities) {
    const canonical = getCanonicalName(entity.text)
    let foundGroup = false

    for (const group of groups) {
      const groupCanonical = getCanonicalName(group[0].text)
      if (namesMatch(canonical, groupCanonical)) {
        group.push(entity)
        foundGroup = true
        break
      }
    }

    if (!foundGroup) {
      groups.push([entity])
    }
  }

  // Assign canonicalText to all entities in each group
  const resolved: MergedEntity[] = []

  for (const group of groups) {
    // Use the longest text variant as canonical representative
    const canonical = group
      .map((e) => e.text)
      .sort((a, b) => b.length - a.length)[0]

    for (const entity of group) {
      resolved.push({
        ...entity,
        canonicalText: canonical
      })
    }
  }

  return [...resolved, ...otherEntities]
}
