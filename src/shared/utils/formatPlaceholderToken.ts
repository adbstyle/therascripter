import type { TipTapPlaceholderChipAttrs } from '../types'

/**
 * Text token of a placeholder chip: `[PERSON 1]`, `[ORT 2]`, … — used for
 * every text export and as `EntityMap[…].placeholder`.
 * Not to be confused with the renderer's `formatPlaceholderLabel` (localized
 * UI label without brackets, e.g. "Person 1").
 * Deliberately reads only type + number — `original` is the un-anonymized
 * value and must never leave the chip through a text serializer.
 */
export function formatPlaceholderToken({
  type,
  number
}: Pick<TipTapPlaceholderChipAttrs, 'type' | 'number'>): string {
  return `[${type} ${number}]`
}
