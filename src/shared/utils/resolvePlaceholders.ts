/**
 * Issue #203 — placeholder tokens in free text (session title, LLM summary)
 * resolved to their originals for the Klartext view.
 *
 * Unlike a chip in the transcript, a token in a title or summary is plain
 * text: it carries no entityId, only `[TYPE N]`. What it meant when the text
 * was written can drift — a chip's type is changed (the entity gets a fresh
 * number), a pseudonymization is removed and its number is handed out again,
 * the session is re-anonymized. A token is therefore resolved only when its
 * CURRENT meaning still equals the meaning recorded when the text was
 * written (the snapshot); otherwise it stays as it is (AK 5). The same holds
 * for tokens the current EntityMap does not resolve unambiguously.
 */
import type { EntityMap, PlaceholderSnapshot } from '../types'

export type { PlaceholderSnapshot }

/** Same shape as `formatPlaceholderToken` output; types are upper-case letters. */
const TOKEN_PATTERN = /\[[A-ZÄÖÜ]+ \d+\]/g

/**
 * Token → original for every token that exactly one EntityMap entry carries
 * and whose original is not empty. Ambiguous tokens are left out on purpose:
 * guessing between two originals could show the wrong person's name.
 */
export function uniqueOriginalsByToken(
  entityMap: EntityMap | null | undefined
): Map<string, string> {
  const result = new Map<string, string>()
  if (!entityMap || typeof entityMap !== 'object') return result
  const ambiguous = new Set<string>()
  for (const entry of Object.values(entityMap)) {
    if (!entry || typeof entry !== 'object') continue
    const { placeholder, original } = entry
    if (typeof placeholder !== 'string' || typeof original !== 'string') continue
    if (ambiguous.has(placeholder)) continue
    if (result.has(placeholder)) {
      result.delete(placeholder)
      ambiguous.add(placeholder)
      continue
    }
    if (original.trim().length === 0) continue
    result.set(placeholder, original)
  }
  return result
}

function tokensOf(text: string): Set<string> {
  return new Set(text.match(TOKEN_PATTERN) ?? [])
}

/**
 * Snapshot for a freshly written text: the current meaning of each token it
 * contains. Tokens already in `previous` keep their recorded meaning — an
 * edit of the text must not "refresh" a token whose meaning drifted since
 * the text was first written. Returns null when nothing can be recorded.
 */
export function buildPlaceholderSnapshot(
  text: string | null | undefined,
  entityMap: EntityMap | null | undefined,
  previous: PlaceholderSnapshot | null = null
): PlaceholderSnapshot | null {
  if (!text) return null
  const current = uniqueOriginalsByToken(entityMap)
  const snapshot: PlaceholderSnapshot = {}
  for (const token of tokensOf(text)) {
    const recorded = previous?.[token]
    if (typeof recorded === 'string') snapshot[token] = recorded
    else {
      const original = current.get(token)
      if (original !== undefined) snapshot[token] = original
    }
  }
  return Object.keys(snapshot).length > 0 ? snapshot : null
}

/**
 * Text with every token replaced by its original where the snapshot and the
 * current EntityMap agree on it; every other token stays (AK 5, AK 6).
 */
export function resolvePlaceholders(
  text: string,
  entityMap: EntityMap | null | undefined,
  snapshot: PlaceholderSnapshot | null | undefined
): string {
  if (!text || !snapshot) return text
  let current: Map<string, string> | null = null
  return text.replace(TOKEN_PATTERN, (token) => {
    const recorded = snapshot[token]
    if (typeof recorded !== 'string') return token
    current ??= uniqueOriginalsByToken(entityMap)
    return current.get(token) === recorded ? recorded : token
  })
}

/** Tolerant parse of a persisted snapshot: anything but a string→string object is null. */
export function parsePlaceholderSnapshot(
  json: string | null | undefined
): PlaceholderSnapshot | null {
  if (!json) return null
  try {
    const value: unknown = JSON.parse(json)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const snapshot: PlaceholderSnapshot = {}
    for (const [token, original] of Object.entries(value)) {
      if (typeof original === 'string') snapshot[token] = original
    }
    return snapshot
  } catch {
    return null
  }
}
