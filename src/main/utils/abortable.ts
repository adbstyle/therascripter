/**
 * Race a promise against an AbortSignal. Rejects with a German user-facing
 * message when the signal fires (or was already aborted) while the promise
 * is still pending.
 *
 * Zweck: In-Process-Awaits (pdf.js getDocument/getPage) settlebar machen,
 * wenn der Watchdog abbricht — das zugrunde liegende Work läuft ggf. im
 * Hintergrund weiter (Sync-Code ist nicht unterbrechbar), aber der Executor
 * settlet und die Single-Slot-Queue bleibt nicht für immer wedged.
 */
// PromiseLike statt Promise: pdf.js liefert eigene Thenable-Typen, die TS
// sonst auf T=unknown zurückfallen lassen.
export function abortable<T>(promise: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return Promise.resolve(promise)
  if (signal.aborted) {
    return Promise.reject(new Error('Verarbeitung abgebrochen'))
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new Error('Verarbeitung abgebrochen'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      }
    )
  })
}
