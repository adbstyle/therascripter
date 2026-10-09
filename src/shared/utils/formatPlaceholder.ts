import type { TipTapPlaceholderChipAttrs } from '../types'

/**
 * Text form of a placeholder chip: `[PERSON 1]`, `[ORT 2]`, …
 * Deliberately reads only type + number — `original` is the un-anonymized
 * value and must never leave the chip through a text serializer.
 */
export function formatPlaceholder({
  type,
  number
}: Pick<TipTapPlaceholderChipAttrs, 'type' | 'number'>): string {
  return `[${type} ${number}]`
}
