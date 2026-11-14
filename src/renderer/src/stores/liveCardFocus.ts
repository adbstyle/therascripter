/**
 * Fokus nach «Aufnahme starten» (Review #225): wer eine Aufnahme startet,
 * landet mit dem Fokus auf «Aufnahme stoppen» der Live-Karte, sobald sie
 * erscheint — auf der Sitzungsliste wie im Verlauf eines Dossiers. Die Karte
 * erscheint erst nach dem Nachladen der Liste, deshalb ein einmaliger
 * Auftrag, den die Karte beim Erscheinen einlöst. Er verfällt nach kurzer
 * Zeit, damit ein späterer Seitenwechsel den Fokus nicht unerwartet springen
 * lässt.
 */

const VALID_MS = 5_000

let requestedAt: number | null = null

export function requestLiveCardFocus(now: number = Date.now()): void {
  requestedAt = now
}

export function cancelLiveCardFocus(): void {
  requestedAt = null
}

/** true genau einmal, wenn ein frischer Auftrag besteht. */
export function consumeLiveCardFocus(now: number = Date.now()): boolean {
  const pending = requestedAt !== null && now - requestedAt <= VALID_MS
  requestedAt = null
  return pending
}
